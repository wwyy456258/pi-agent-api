import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.js";
import { ApiError, envelope, publicError } from "./errors.js";
import { Store } from "./store.js";
import type { RequestRow } from "./store.js";
import type { AgentBackend, Attachment, ChatInput, ChatResult, ModelInfo } from "./types.js";

export interface Context {
  requestId: string;
  chatId?: string;
  controller: AbortController;
  input?: ChatInput;
  model?: ModelInfo;
  ttl?: number;
  keyHash?: string;
  replay?: RequestRow;
  isNew: boolean;
  submitted: boolean;
  files: Attachment[];
  temp: string;
  moved: string[];
  release: () => void;
  releaseTask?: Promise<void>;
  processing?: boolean;
}

function safeFilename(value: string): string {
  let name = basename(value.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "_");
  if (!name || name === "." || name === "..") name = "attachment";
  const chars = [...name];
  while (Buffer.byteLength(chars.join("")) > 240) chars.pop();
  return chars.join("");
}

function cancelled(): ApiError { return new ApiError(409, "request_cancelled", "The original request was cancelled."); }

export class ChatService {
  private chatLocks = new Set<string>();
  private keyLocks = new Map<string, Context>();
  private contexts = new Set<Context>();
  private cleanupTask?: Promise<void>;
  private closing = false;
  private shutdownTask?: Promise<void>;

  constructor(readonly config: Config, readonly store: Store, readonly backend: AgentBackend,
    private now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.chat.storage_dir, { recursive: true });
    await rm(join(this.config.chat.storage_dir, ".tmp"), { recursive: true, force: true });
    await mkdir(join(this.config.chat.storage_dir, ".tmp"), { recursive: true });
    this.store.recover(this.now());
    // A crash between filesystem commit and the first SQLite commit may leave a new orphan directory.
    for (const entry of await readdir(this.config.chat.storage_dir, { withFileTypes: true })) {
      if (/^chat_[0-9a-f-]{36}$/.test(entry.name) && !this.store.chat(entry.name)) {
        await rm(join(this.config.chat.storage_dir, entry.name), { recursive: true, force: true });
      }
    }
    await this.cleanup();
  }

  context(requestId: string): Context {
    if (this.closing) throw new ApiError(503, "service_unavailable", "The service is shutting down.");
    const context: Context = { requestId, controller: new AbortController(), isNew: false, submitted: false,
      files: [], moved: [], temp: join(this.config.chat.storage_dir, ".tmp", randomUUID()), release: () => {} };
    this.contexts.add(context);
    return context;
  }

  private assertChat(id: string): void {
    const chat = this.store.chat(id);
    if (!chat) throw new ApiError(404, "chat_not_found", "The chat does not exist.");
    if (chat.expired || (chat.expires_at <= this.now() && !this.chatLocks.has(id))) {
      throw new ApiError(410, "chat_expired", "The chat has expired. Start a new chat.", undefined, id);
    }
  }

  async prepare(context: Context, input: ChatInput, key?: string): Promise<void> {
    if (context.controller.signal.aborted) throw cancelled();
    if (context.input) throw new ApiError(400, "invalid_request", "Only one payload is accepted.");
    context.input = input;
    if (key !== undefined) {
      if (!key.trim()) throw new ApiError(400, "invalid_request", "Idempotency-Key must not be empty.");
      const hash = createHash("sha256").update(key).digest("hex");
      const active = this.keyLocks.get(hash);
      if (active) throw new ApiError(409, "request_in_progress", "The original request is still in progress.", active.requestId, active.submitted ? active.chatId : undefined);
      const previous = this.store.requestByKey(hash);
      if (previous) {
        this.assertChat(previous.chat_id);
        context.chatId = previous.chat_id;
        context.requestId = previous.id;
        context.replay = previous;
        return;
      }
      this.keyLocks.set(hash, context);
      context.keyHash = hash;
    }
    if (input.chat_id) { this.assertChat(input.chat_id); context.chatId = input.chat_id; }
    else { context.chatId = `chat_${randomUUID()}`; context.isNew = true; }
    if (this.chatLocks.has(context.chatId)) throw new ApiError(409, "chat_busy", "The chat is processing another request.");
    this.chatLocks.add(context.chatId);
    context.release = () => { this.chatLocks.delete(context.chatId!); };
    context.ttl = context.isNew ? (input.ttl_seconds ?? this.config.chat.ttl_seconds) : this.store.chat(context.chatId)!.ttl;
    context.model = await this.backend.resolveModel(input.model);
  }

  async receiveFile(context: Context, filename: string, stream: Readable): Promise<void> {
    const max = this.config.upload;
    if (max.max_files && context.files.length >= max.max_files) {
      throw new ApiError(413, "upload_limit_exceeded", "The configured file count limit was exceeded.");
    }
    const name = safeFilename(filename);
    const directory = join(context.temp, randomUUID());
    await mkdir(directory, { recursive: true });
    // Multipart parsers can close a malformed file while we await filesystem I/O.
    // Attaching a pipeline after that close can otherwise wait forever.
    if (stream.destroyed) throw new ApiError(400, "invalid_request", "The multipart file was terminated early.");
    const path = join(directory, name);
    const hash = createHash("sha256");
    let size = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (max.max_file_bytes && size > max.max_file_bytes) {
        done(new ApiError(413, "upload_limit_exceeded", "The configured file size limit was exceeded."));
      } else { hash.update(chunk); done(null, chunk); }
    } });
    await pipeline(stream, measure, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal: context.controller.signal });
    context.files.push({ name, path, sha256: hash.digest("hex"), size });
  }

  private fingerprint(context: Context): string {
    const input = context.input!;
    return createHash("sha256").update(JSON.stringify({
      message: input.message, chat_id: input.chat_id ?? null, model: input.model ?? null,
      ttl_seconds: input.ttl_seconds ?? null,
      files: context.files.map(({ name, sha256, size }) => ({ name, sha256, size })),
    })).digest("hex");
  }

  async execute(context: Context): Promise<{ status: number; body: unknown }> {
    const fingerprint = this.fingerprint(context);
    if (context.replay) {
      this.assertChat(context.chatId!);
      if (context.replay.fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict", "The Key was used with a different request.");
      return { status: context.replay.status!, body: JSON.parse(context.replay.body!) as unknown };
    }
    if (context.controller.signal.aborted) throw cancelled();
    const chatId = context.chatId!;
    const filesRoot = join(this.config.chat.storage_dir, chatId, "files");
    await mkdir(filesRoot, { recursive: true });
    for (const file of context.files) {
      const destination = join(filesRoot, randomUUID());
      await rename(dirname(file.path), destination);
      context.moved.push(destination);
      file.path = join(destination, file.name);
    }
    if (context.controller.signal.aborted) throw cancelled();
    this.store.submit({ requestId: context.requestId, chatId, keyHash: context.keyHash ?? null,
      fingerprint, ttl: context.ttl!, isNew: context.isNew, now: this.now() });
    context.submitted = true;
    let reply = "";
    let error: ApiError | undefined;
    let handle;
    try {
      handle = await this.backend.open({ sessionFile: this.store.chat(chatId)!.session_file, model: context.model!,
        onSessionFile: (path) => this.store.setSession(chatId, path) });
      if (context.controller.signal.aborted) throw cancelled();
      reply = await handle.run(context.input!.message, context.files, context.controller.signal);
      if (context.controller.signal.aborted) throw cancelled();
    } catch (caught) { error = context.controller.signal.aborted ? cancelled() : publicError(caught); }
    finally {
      try { await handle?.dispose(); } catch (caught) { error ??= publicError(caught); }
    }
    const expiresAt = this.now() + context.ttl! * 1000;
    const status = error?.status ?? 200;
    const body = error ? envelope(error, context.requestId, chatId) : {
      request_id: context.requestId, chat_id: chatId, model: context.model!.id,
      reply, expires_at: new Date(expiresAt).toISOString(),
    } satisfies ChatResult;
    this.store.finish(context.requestId, chatId, status, body, expiresAt);
    return { status, body };
  }

  release(context: Context): Promise<void> {
    return context.releaseTask ??= this.releaseContext(context);
  }

  private async releaseContext(context: Context): Promise<void> {
    try {
      await rm(context.temp, { recursive: true, force: true });
      if (!context.submitted && !context.replay) {
        for (const path of context.moved) await rm(path, { recursive: true, force: true });
        if (context.isNew && context.chatId) {
          await rm(join(this.config.chat.storage_dir, context.chatId), { recursive: true, force: true });
        }
      }
    } finally {
      context.release();
      if (context.keyHash) this.keyLocks.delete(context.keyHash);
      this.contexts.delete(context);
    }
  }

  cleanup(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    this.cleanupTask = this.cleanExpired().finally(() => { this.cleanupTask = undefined; });
    return this.cleanupTask;
  }

  private async cleanExpired(): Promise<void> {
    for (const chat of this.store.expirationCandidates(this.now())) {
      if (this.chatLocks.has(chat.id)) continue;
      this.chatLocks.add(chat.id);
      try {
        this.store.expire(chat.id);
        await rm(join(this.config.chat.storage_dir, chat.id), { recursive: true, force: true });
        this.store.markCleaned(chat.id);
      } finally { this.chatLocks.delete(chat.id); }
    }
  }

  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.stop();
  }

  private async stop(): Promise<void> {
    this.closing = true;
    const until = Date.now() + this.config.server.shutdown_grace_seconds * 1000;
    while (this.contexts.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    for (const context of this.contexts) context.controller.abort();
    while (this.contexts.size) await new Promise(resolve => setTimeout(resolve, 25));
    await this.cleanupTask;
    await this.backend.close();
    await this.store.close();
  }
}
