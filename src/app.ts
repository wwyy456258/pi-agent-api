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
import { Store } from "./store.ts";
import type { AgentBackend } from "./types.ts";

export async function createApp(config: Config, backend: AgentBackend, options: { now?: () => number } = {}): Promise<{
  app: FastifyInstance; service: ChatService; close: () => Promise<void>;
}> {
  const store = await Store.open(config.storage.database_path);
  const service = new ChatService(config, store, backend, options.now);
  try { await service.initialize(); } catch (error) { await store.close(); await backend.close(); throw error; }
  const contexts = new WeakMap<FastifyRequest, Context>();
  const expectedKey = createHash("sha256").update(config.apiKey).digest();
  const app = Fastify({ logger: false, requestTimeout: 0,
    bodyLimit: config.upload.max_request_bytes || Number.MAX_SAFE_INTEGER,
    genReqId: () => `req_${randomUUID()}` });

  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !timingSafeEqual(createHash("sha256").update(supplied).digest(), expectedKey)) {
      throw new ApiError(401, "unauthorized", "A valid API Key is required.");
    }
    if (request.method === "POST" && request.routeOptions.url === "/v1/chat") {
      const context = service.context(request.id);
      contexts.set(request, context);
      const disconnect = () => {
        if (!reply.raw.writableFinished) context.controller.abort();
        if (!context.processing) {
          void service.release(context).catch(() => { process.stderr.write("pi-http: abandoned upload cleanup failed.\n"); });
        }
      };
      request.raw.once("aborted", disconnect);
      reply.raw.once("close", disconnect);
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

  // Also runs for parser failures, which occur before the route handler.
  app.addHook("onResponse", async request => {
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
            await service.prepare(context, parseInput(JSON.parse(part.value)), key);
          } else {
            if (!foundPayload || part.fieldname !== "files") invalid("Each file must use files and follow payload.");
            activeFile = part.file;
            await service.receiveFile(context, part.filename, part.file);
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
        await service.prepare(context, parseInput(request.body), key);
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
    void service.cleanup().catch(() => { process.stderr.write("pi-http: cleanup failed; it will be retried.\n"); });
  }, config.chat.cleanup_interval_seconds * 1000);
  cleanup.unref();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clearInterval(cleanup);
    const closed = app.close();
    await service.shutdown();
    await closed;
  })();
  app.addHook("onClose", async () => { clearInterval(cleanup); await service.shutdown(); });
  return { app, service, close };
}
