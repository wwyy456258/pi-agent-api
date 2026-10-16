import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { ChatService } from "./chat-service.ts";
import type { Context } from "./chat-service.ts";
import type { Config } from "./config.ts";
import { ApiError, envelope, invalid, publicError } from "./errors.ts";
import { parseInput } from "./input.ts";
import { knownSecrets, redact } from "./redaction.ts";
import { HttpLog } from "./logging.ts";
import { ensureDirectory } from "../scripts/configuration.mjs";
import { Store } from "./store.ts";
import type { AgentBackend } from "./types.ts";

export async function createApp(config: Config, backend: AgentBackend, options: { now?: () => number } = {}): Promise<{
  app: FastifyInstance; service: ChatService; log: HttpLog; close: () => Promise<void>;
}> {
  await ensureDirectory(config.paths.data_dir);
  await ensureDirectory(config.paths.config_dir);
  const store = await Store.open(config.storage.database_path);
  let log: HttpLog;
  try { log = await HttpLog.open(config); }
  catch (error) { await store.close(); throw error; }
  const service = new ChatService(config, store, backend, options.now);
  try { await service.initialize(); } catch (error) { await store.close(); await backend.close(); await log.close(); throw error; }
  interface Audit { started: number; authenticated: boolean; input?: unknown; files: number[]; output?: unknown; done: boolean }
  const audits = new WeakMap<FastifyRequest, Audit>();
  const finishLog = async (request: FastifyRequest, status: number, aborted = false) => {
    const audit = audits.get(request);
    if (!audit || audit.done) return;
    audit.done = true;
    await log.record(aborted ? "request_aborted" : "response_sent", {
      request_id: request.id, method: request.method, path: request.url.split("?")[0], status,
      duration_ms: Math.round((performance.now() - audit.started) * 1000) / 1000,
      input: audit.authenticated ? log.body(audit.input) : undefined,
      files: { count: audit.files.length, total_bytes: audit.files.reduce((a, b) => a + b, 0),
        sizes_bytes: audit.files.slice(0, 128), omitted: Math.max(0, audit.files.length - 128) },
      response_bytes: audit.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(audit.output)),
      output: log.body(audit.output),
    });
  };
  const contexts = new WeakMap<FastifyRequest, Context>();
  const expectedKey = createHash("sha256").update(config.apiKey).digest();
  const app = Fastify({ logger: false, requestTimeout: 0,
    bodyLimit: config.upload.max_request_bytes || Number.MAX_SAFE_INTEGER,
    genReqId: () => `req_${randomUUID()}` });

  app.addHook("onRequest", async (request, reply) => {
    const audit: Audit = { started: performance.now(), authenticated: false, files: [], done: false };
    audits.set(request, audit);
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) void finishLog(request, 499, true);
    });
    await log.record("request_received", { request_id: request.id, method: request.method,
      path: request.url.split("?")[0], remote_ip: request.ip });
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !timingSafeEqual(createHash("sha256").update(supplied).digest(), expectedKey)) {
      throw new ApiError(401, "unauthorized", "A valid API Key is required.");
    }
    audit.authenticated = true;
    if (request.method === "POST" && request.routeOptions.url === "/v1/chat") {
      const context = service.context(request.id);
      contexts.set(request, context);
      const disconnect = () => {
        if (!reply.raw.writableFinished) context.controller.abort();
        if (!context.processing) {
          void service.release(context).catch(() => { void log.record("cleanup_failed", { request_id: request.id, phase: "abandoned_upload" }); });
        }
      };
      request.raw.once("aborted", disconnect);
      reply.raw.once("close", disconnect);
      if (request.raw.aborted || reply.raw.destroyed) disconnect();
      context.controller.signal.addEventListener("abort", () => {
        if (!request.raw.complete) request.raw.destroy();
      }, { once: true });
    }
  });

  app.addHook("preParsing", async (request, _reply, payload) => {
    const limit = config.upload.max_request_bytes;
    if (!limit) return payload;
    const length = Number(request.headers["content-length"]);
    if (length > limit) throw new ApiError(413, "upload_limit_exceeded", "The configured request size limit was exceeded.");
    // Fastify enforces the JSON limit. Multipart consumes request.raw directly,
    // so its byte counter must be attached when that iterator starts, not via a replacement stream.
    return payload;
  });

  await app.register(multipart, { throwFileSizeLimit: true, limits: {
    fileSize: config.upload.max_file_bytes || Infinity,
    files: config.upload.max_files || Infinity,
    fields: 1, parts: Infinity, fieldSize: config.upload.max_request_bytes || Number.MAX_SAFE_INTEGER,
  } });

  app.setErrorHandler((caught, request, reply) => {
    const context = contexts.get(request);
    const error = publicError(caught);
    reply.code(error.status).send(envelope(error, context?.requestId ?? request.id, context?.submitted || context?.replay || !context?.isNew ? context?.chatId : undefined));
  });

  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (payload && typeof payload === "object" && "error" in payload) {
      const body = payload as { error?: { message?: unknown } };
      if (typeof body.error?.message === "string") {
        payload = { ...payload, error: { ...body.error, message: redact(body.error.message, [config.apiKey, ...knownSecrets()]) } };
      }
    }
    const audit = audits.get(request);
    if (audit) audit.output = payload;
    return payload;
  });
  // Also runs for parser failures, which occur before the route handler.
  app.addHook("onResponse", async (request, reply) => {
    await finishLog(request, reply.statusCode);
    const context = contexts.get(request);
    if (context) { contexts.delete(request); await service.release(context); }
  });

  app.get("/v1/models", async () => backend.models());
  app.post("/v1/chat", async (request, reply) => {
    const context = contexts.get(request)!;
    context.processing = true;
    const key = request.headers["idempotency-key"];
    let result: { status: number; body: unknown };
    let totalBytes = 0;
    let sizeError: ApiError | undefined;
    let activeFile: Readable | undefined;
    const measure = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (config.upload.max_request_bytes && totalBytes > config.upload.max_request_bytes) {
        sizeError ??= new ApiError(413, "upload_limit_exceeded", "The configured request size limit was exceeded.");
        activeFile?.destroy(sizeError);
      }
    };
    try {
      if (Array.isArray(key)) invalid("Idempotency-Key must occur once.");
      if (request.isMultipart()) {
        let foundPayload = false;
        request.raw.on("data", measure);
        for await (const part of request.parts()) {
          if (sizeError) throw sizeError;
          if (part.type === "field") {
            if (part.fieldname !== "payload" || foundPayload || part.valueTruncated) invalid("Multipart requires one payload field before files.");
            foundPayload = true;
            if (typeof part.value !== "string") invalid("payload must be a JSON string.");
            const input: unknown = JSON.parse(part.value);
            audits.get(request)!.input = input;
            const parsed = parseInput(input);
            await log.record("request_input", { request_id: request.id, input: log.body(parsed) });
            await service.prepare(context, parsed, key);
          } else {
            if (!foundPayload || part.fieldname !== "files") invalid("Each file must use files and follow payload.");
            activeFile = part.file;
            const audit = audits.get(request)!;
            const index = audit.files.push(0) - 1;
            await service.receiveFile(context, part.filename, part.file, size => { audit.files[index] = size; });
            activeFile = undefined;
            if (part.file.truncated) throw new ApiError(413, "upload_limit_exceeded", "The configured file size limit was exceeded.");
          }
        }
        if (sizeError) throw sizeError;
        if (!foundPayload) invalid("Multipart requires payload.");
      } else {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          throw new ApiError(415, "unsupported_media_type", "Use JSON or multipart/form-data.");
        }
        audits.get(request)!.input = request.body;
        const parsed = parseInput(request.body);
        await log.record("request_input", { request_id: request.id, input: log.body(parsed) });
        await service.prepare(context, parsed, key);
      }
      result = await service.execute(context);
    } catch (caught) {
      const error = sizeError ?? publicError(caught);
      result = { status: error.status, body: envelope(error, context.requestId,
        context.submitted || context.replay || !context.isNew ? context.chatId : undefined) };
    } finally {
      request.raw.off("data", measure);
      contexts.delete(request);
      await service.release(context);
    }
    return reply.code(result.status).send(result.body);
  });

  const cleanup = setInterval(() => {
    void service.cleanup().catch(() => { void log.record("cleanup_failed", { retry: true }); });
  }, config.chat.cleanup_interval_seconds * 1000);
  cleanup.unref();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearInterval(cleanup);
    const closed = app.close();
    await service.shutdown();
    await closed;
  })();
  app.addHook("onClose", async () => {
    clearInterval(cleanup); await service.shutdown();
    await log.record("listener_closed"); await log.close();
  });
  await log.record("listener_created", { config_path: config.configPath, data_dir: config.paths.data_dir });
  return { app, service, log, close };
}
