import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { AgentBackend, Attachment, ModelInfo } from "../src/types.js";

const model = (id: string): ModelInfo => ({ id: `test/${id}`, name: id, provider: "test" });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class TestBackend implements AgentBackend {
  calls: { message: string; files: Attachment[]; model: string; session: string }[] = [];
  started = deferred();
  unblock = deferred();
  aborted = deferred();
  failModels = false;
  constructor(private directory: string, private configuredDefault?: string) {}
  async models() { return { default_model: this.configuredDefault ?? "test/pi-default", models: [model("pi-default"), model("other")] }; }
  async resolveModel(explicit?: string) {
    if (this.failModels) throw new ApiError(503, "default_model_unavailable", "No default model.");
    const id = explicit ?? this.configuredDefault ?? "test/pi-default";
    if (!id.startsWith("test/")) throw new ApiError(400, "model_not_found", "Unknown model.");
    return model(id.slice(5));
  }
  async open(options: Parameters<AgentBackend["open"]>[0]) {
    const session = options.sessionFile ?? join(this.directory, `pi-session-${randomUUID()}.json`);
    options.onSessionFile(session);
    return {
      run: async (message: string, files: Attachment[], signal: AbortSignal) => {
        this.calls.push({ message, files: structuredClone(files), model: options.model.id, session });
        await writeFile(session, JSON.stringify(this.calls.filter(call => call.session === session)));
        if (message === "block") {
          this.started.resolve();
          await new Promise<void>((resolve, reject) => {
            const abort = () => { this.aborted.resolve(); reject(new Error("cancelled")); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            void this.unblock.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
          });
        }
        if (message === "fail") throw new ApiError(502, "upstream_error", "Provider failed.");
        for (const file of files) assert.equal((await readFile(file.path)).length, file.size);
        return `reply:${message}`;
      },
      dispose: async () => {},
    };
  }
  async close() {}
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, override: object = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-http-test-"));
  await writeFile(join(directory, "pi-http.config.json"), JSON.stringify(override));
  const config = await loadConfig({ cwd: directory, env: { PI_HTTP_API_KEY: "test-service-key" } });
  const backend = new TestBackend(directory, config.model.default);
  let now = Date.now();
  const server = await createApp(config, backend, { now: () => now });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: "Bearer test-service-key" };
  const chat = (payload: object, key?: string) => server.app.inject({ method: "POST", url: "/v1/chat", payload,
    headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) } });
  return { ...server, directory, config, backend, headers, chat, advance: (ms: number) => { now += ms; } };
}

function form(payload: object, files: { name: string; data: Buffer }[], payloadFirst = true) {
  const boundary = `boundary-${randomUUID()}`;
  const field = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`);
  const parts = files.map(file => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.data, Buffer.from("\r\n"),
  ]));
  return { payload: Buffer.concat([...(payloadFirst ? [field, ...parts] : [...parts, field]), Buffer.from(`--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}` };
}

test("both endpoints require the service key; malformed input uses the error envelope", async t => {
  const f = await fixture(t);
  for (const url of ["/v1/chat", "/v1/models"]) {
    const result = await f.app.inject({ method: url.endsWith("chat") ? "POST" : "GET", url, payload: url.endsWith("chat") ? { message: "hello" } : undefined });
    assert.equal(result.statusCode, 401);
    assert.equal(result.json().error.code, "unauthorized");
    assert.match(result.json().request_id, /^req_/);
    assert.ok(!result.body.includes("test-service-key"));
  }
  assert.equal((await f.app.inject({ url: "/v1/models", headers: f.headers })).json().default_model, "test/pi-default");
  for (const payload of [{ message: " " }, { message: "hi", stream: false }, { message: "hi", model: null }, { message: "hi", ttl_seconds: 0 }]) {
    assert.equal((await f.chat(payload)).statusCode, 400);
  }
  const malformed = await f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "content-type": "application/json" }, payload: "{" });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await readdir(f.config.chat.storage_dir)).filter(name => name.startsWith("chat_")).length, 0);
});

test("chat resumes its Pi session; model selection is per request; TTL cannot be changed", async t => {
  const f = await fixture(t, { model: { default: "test/config-default" } });
  const first = await f.chat({ message: "first", model: "test/other", ttl_seconds: 60 });
  assert.equal(first.statusCode, 200);
  const id = first.json().chat_id;
  assert.equal(first.json().model, "test/other");
  const second = await f.chat({ chat_id: id, message: "second" });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().model, "test/config-default");
  assert.equal(f.backend.calls[0]!.session, f.backend.calls[1]!.session);
  assert.equal((await f.chat({ chat_id: id, message: "hi", ttl_seconds: 60 })).statusCode, 400);
  assert.equal((await f.chat({ chat_id: "../../somewhere", message: "hi" })).statusCode, 404);
  assert.equal((await f.chat({ message: "hi", model: "unknown/model" })).statusCode, 400);
});

test("multipart preserves arbitrary bytes, duplicate filenames and append-only attachments", async t => {
  const f = await fixture(t);
  const data = Buffer.alloc(2 * 1024 * 1024, 173);
  const body = form({ message: "read files" }, [{ name: "../same.bin", data }, { name: "same.bin", data: Buffer.from("other") }]);
  const response = await f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "content-type": body.contentType }, payload: body.payload });
  assert.equal(response.statusCode, 200, response.body);
  const files = f.backend.calls[0]!.files;
  assert.equal(files.length, 2);
  assert.equal(files[0]!.name, "same.bin");
  assert.notEqual(files[0]!.path, files[1]!.path);
  assert.deepEqual(await readFile(files[0]!.path), data);
  assert.ok(files[0]!.path.startsWith(join(f.config.chat.storage_dir, response.json().chat_id, "files")));
  const next = await f.chat({ chat_id: response.json().chat_id, message: "reuse files" });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(await readFile(files[0]!.path), data);
  assert.deepEqual(await readdir(join(f.config.chat.storage_dir, ".tmp")), []);
});

test("invalid multipart and file limits reject the whole message and clean temporary files", async t => {
  const f = await fixture(t, { upload: { max_file_bytes: 4 } });
  for (const payloadFirst of [true, false]) {
    const body = form({ message: "read" }, [{ name: "a", data: Buffer.from("12345") }], payloadFirst);
    const response = await f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "content-type": body.contentType }, payload: body.payload });
    assert.equal(response.statusCode, payloadFirst ? 413 : 400, response.body);
  }
  assert.equal(f.backend.calls.length, 0);
  assert.deepEqual(await readdir(join(f.config.chat.storage_dir, ".tmp")), []);
  assert.equal((await readdir(f.config.chat.storage_dir)).filter(name => name.startsWith("chat_")).length, 0);
});

test("file count and whole-request limits return 413 and leave no submitted message", async t => {
  const files = await fixture(t, { upload: { max_files: 1 } });
  const body = form({ message: "read" }, [{ name: "a", data: Buffer.from("1") }, { name: "b", data: Buffer.from("2") }]);
  const response = await files.app.inject({ method: "POST", url: "/v1/chat", headers: { ...files.headers, "content-type": body.contentType }, payload: body.payload });
  assert.equal(response.statusCode, 413, response.body);
  assert.equal(files.backend.calls.length, 0);
  assert.deepEqual(await readdir(join(files.config.chat.storage_dir, ".tmp")), []);
  const whole = await fixture(t, { upload: { max_request_bytes: 30 } });
  const tooLarge = await whole.chat({ message: "x".repeat(100) });
  assert.equal(tooLarge.statusCode, 413, tooLarge.body);
  assert.equal(whole.backend.calls.length, 0);
});

test("multipart whole-request limit accepts valid bodies and rejects chunked bodies without Content-Length", async t => {
  const f = await fixture(t, { upload: { max_request_bytes: 4096 } });
  const valid = form({ message: "read" }, [{ name: "a", data: Buffer.alloc(1000, 1) }]);
  const accepted = await f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "content-type": valid.contentType }, payload: valid.payload });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const large = form({ message: "large" }, [{ name: "a", data: Buffer.alloc(10000, 1) }]);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${address}/v1/chat`, { method: "POST", headers: { ...f.headers, "content-type": large.contentType } }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.write(large.payload.subarray(0, 2000));
    req.end(large.payload.subarray(2000));
  });
  assert.equal(response.status, 413, response.body);
  assert.equal(f.backend.calls.length, 1);
  assert.deepEqual(await readdir(join(f.config.chat.storage_dir, ".tmp")), []);
});

test("truncated multipart does not submit to Pi or leave the existing chat busy", async t => {
  const f = await fixture(t);
  const first = await f.chat({ message: "initial" });
  const id = first.json().chat_id;
  const body = form({ chat_id: id, message: "read" }, [{ name: "a", data: Buffer.from("contents") }]);
  const response = await f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "content-type": body.contentType }, payload: body.payload.subarray(0, body.payload.length - 15) });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(f.backend.calls.length, 1);
  assert.deepEqual(await readdir(join(f.config.chat.storage_dir, ".tmp")), []);
  assert.equal((await f.chat({ chat_id: id, message: "continue" })).statusCode, 200);
});

test("idempotency replays results before model availability checks and detects conflicts", async t => {
  const f = await fixture(t);
  const first = await f.chat({ message: "one" }, "unique-key");
  f.backend.failModels = true;
  const replay = await f.chat({ message: "one" }, "unique-key");
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
  assert.equal((await f.chat({ message: "different" }, "unique-key")).statusCode, 409);
  assert.equal(f.backend.calls.length, 1);
  f.backend.failModels = false;
  const failed = await f.chat({ chat_id: first.json().chat_id, message: "fail" }, "failed-key");
  assert.equal(failed.statusCode, 502);
  assert.deepEqual((await f.chat({ chat_id: first.json().chat_id, message: "fail" }, "failed-key")).json(), failed.json());
  assert.equal(f.backend.calls.length, 2);
});

test("multipart replay compares bytes without adding duplicate attachments", async t => {
  const f = await fixture(t);
  const send = (data: string) => {
    const body = form({ message: "read" }, [{ name: "a", data: Buffer.from(data) }]);
    return f.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "idempotency-key": "file-key", "content-type": body.contentType }, payload: body.payload });
  };
  const first = await send("one");
  assert.equal(first.statusCode, 200);
  assert.deepEqual((await send("one")).json(), first.json());
  assert.equal((await send("two")).json().error.code, "idempotency_conflict");
  assert.equal(f.backend.calls.length, 1);
  assert.equal((await readdir(join(f.config.chat.storage_dir, first.json().chat_id, "files"))).length, 1);
});

test("busy chat is protected from expiration, another chat can run, duplicate key is in progress", async t => {
  const f = await fixture(t, { chat: { ttl_seconds: 1 } });
  const first = await f.chat({ message: "initial" });
  const id = first.json().chat_id;
  const running = f.chat({ chat_id: id, message: "block" }, "busy-key");
  await f.backend.started.promise;
  f.advance(5000);
  await f.service.cleanup();
  assert.equal((await f.chat({ chat_id: id, message: "other" })).json().error.code, "chat_busy");
  assert.equal((await f.chat({ chat_id: id, message: "block" }, "busy-key")).json().error.code, "request_in_progress");
  assert.equal((await f.chat({ message: "parallel" })).statusCode, 200);
  f.backend.unblock.resolve();
  assert.equal((await running).statusCode, 200);
  assert.equal((await f.chat({ chat_id: id, message: "after" })).statusCode, 200);
});

test("expiration removes only managed files and preserves 410 tombstones including idempotency keys", async t => {
  const f = await fixture(t, { chat: { ttl_seconds: 1 } });
  const response = await f.chat({ message: "initial" }, "expires-key");
  const id = response.json().chat_id;
  const piSession = f.backend.calls[0]!.session;
  f.advance(2000);
  assert.equal((await f.chat({ chat_id: id, message: "late" })).statusCode, 410);
  await f.service.cleanup();
  await assert.rejects(readFile(join(f.config.chat.storage_dir, id, "files")));
  assert.ok((await readFile(piSession)).length);
  assert.equal((await f.chat({ message: "initial" }, "expires-key")).statusCode, 410);
  const row = f.service.store.requestByKey((await import("node:crypto")).createHash("sha256").update("expires-key").digest("hex"))!;
  assert.equal(row.body, null);
  assert.equal(row.fingerprint, null);
});

test("real socket disconnect cancels execution and the same key does not execute again", async t => {
  const f = await fixture(t);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const req = httpRequest(`${address}/v1/chat`, { method: "POST", headers: {
    ...f.headers, "content-type": "application/json", "idempotency-key": "disconnect-key",
  } });
  req.on("error", () => {});
  req.end(JSON.stringify({ message: "block" }));
  await f.backend.started.promise;
  req.destroy();
  await f.backend.aborted.promise;
  let replay;
  for (let attempt = 0; attempt < 100; attempt++) {
    replay = await f.chat({ message: "block" }, "disconnect-key");
    if (replay.json().error.code !== "request_in_progress") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(replay!.json().error.code, "request_cancelled");
  assert.equal(f.backend.calls.length, 1);
});

test("shutdown cancels an active request after the configured grace period", async t => {
  const f = await fixture(t, { server: { shutdown_grace_seconds: 0 } });
  const pending = f.chat({ message: "block" });
  await f.backend.started.promise;
  const closing = f.close();
  await f.backend.aborted.promise;
  assert.equal((await pending).json().error.code, "request_cancelled");
  await closing;
});

test("startup recovers interrupted requests and idempotency survives restart", async t => {
  const f = await fixture(t);
  const first = await f.chat({ message: "persisted" }, "persist-key");
  f.service.store.submit({ requestId: "req-interrupted", chatId: first.json().chat_id, keyHash: "simulated-key-hash", fingerprint: "fingerprint", ttl: 86400, isNew: false, now: Date.now() });
  await f.close();
  const secondBackend = new TestBackend(f.directory);
  const second = await createApp(f.config, secondBackend);
  t.after(() => second.close());
  const replay = await second.app.inject({ method: "POST", url: "/v1/chat", headers: { ...f.headers, "idempotency-key": "persist-key" }, payload: { message: "persisted" } });
  assert.deepEqual(replay.json(), first.json());
  assert.equal(secondBackend.calls.length, 0);
  assert.equal(JSON.parse(second.service.store.requestByKey("simulated-key-hash")!.body!).error.code, "request_interrupted");
  await second.close();
});

test("config paths, defaults, key requirement and explicit missing file", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-http-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PI_HTTP_API_KEY: "test-service-key" };
  await assert.rejects(loadConfig({ cwd: root, env: {} }), /PI_HTTP_API_KEY/);
  assert.equal((await loadConfig({ cwd: root, env })).model.default, undefined);
  await assert.rejects(loadConfig({ cwd: root, env, path: "missing.json" }));
  await writeFile(join(root, "custom.json"), JSON.stringify({ pi: { cwd: "." }, chat: { storage_dir: "files" } }));
  const configured = await loadConfig({ cwd: "/", env, path: join(root, "custom.json") });
  assert.equal(configured.pi.cwd, root);
  assert.equal(configured.chat.storage_dir, join(root, "files"));
  await writeFile(join(root, "custom.json"), JSON.stringify({ model: { default: "" } }));
  await assert.rejects(loadConfig({ cwd: root, env, path: "custom.json" }));
});
