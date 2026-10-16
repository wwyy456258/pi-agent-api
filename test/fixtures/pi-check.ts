import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentSessionFromServices, createAgentSessionServices, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { PiBackend } from "../../src/pi-backend.js";

const root = process.argv[2]!;
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const requests: { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
const authHeaders: (string | undefined)[] = [];
const toolFile = join(root, "reference.txt");
await writeFile(toolFile, "local-tool-evidence");
const provider = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    authHeaders.push(request.headers.authorization);
    const user = body.messages.filter((message: { role: string }) => message.role === "user").at(-1);
    const toolCall = JSON.stringify(user?.content).includes("[tool]") && body.messages.at(-1)?.role !== "tool";
    if (JSON.stringify(user?.content).includes("[fail]")) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("upstream exploded");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "local-response", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    if (toolCall) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read-reference", type: "function", function: { name: "read", arguments: JSON.stringify({ path: toolFile }) } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: body.messages.at(-1)?.role === "tool" ? "tool-ok" : `reply:${body.model}` });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch { response.writeHead(500); response.end(); }
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const address = provider.address();
assert.ok(address && typeof address !== "string");
await mkdir(join(agentDir, "extensions"), { recursive: true });
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local-test", defaultModel: "model-a", retry: { enabled: false }, compaction: { enabled: false } }));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
  "local-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fake-local-key", models: ["model-a", "model-b"].map(id => ({
    id, name: id, reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })) },
} }));
await writeFile(join(agentDir, "extensions", "confirm.ts"), `export default function(pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt.includes("[confirm]")) await ctx.ui.confirm("Confirm", "Continue?");
  });
}`);
const config = await loadConfig({ cwd: root, env: { PI_HTTP_API_KEY: "fake-service-key" } });
const backend = await PiBackend.create(config);
const server = await createApp(config, backend);
const chat = (payload: object) => server.app.inject({ method: "POST", url: "/v1/chat", headers: { authorization: "Bearer fake-service-key" }, payload });
try {
  const listing = await backend.models();
  assert.equal(listing.default_model, "local-test/model-a");
  assert.ok(listing.models.some(model => model.id === "local-test/model-b"));
  const first = await chat({ message: "first turn" });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().reply, "reply:model-a");
  const id = first.json().chat_id;
  const second = await chat({ chat_id: id, message: "second turn", model: "local-test/model-b" });
  assert.equal(second.json().reply, "reply:model-b", second.body);
  assert.ok(JSON.stringify(requests[1]!.messages).includes("first turn"));
  const third = await chat({ chat_id: id, message: "third turn" });
  assert.equal(third.json().model, "local-test/model-a");
  assert.equal(third.json().reply, "reply:model-a", third.body);
  const tool = await chat({ chat_id: id, message: "[tool] Read the reference file." });
  assert.equal(tool.json().reply, "tool-ok", tool.body);
  assert.ok(JSON.stringify(requests.at(-1)!.messages).includes("local-tool-evidence"));
  const before = requests.length;
  const interaction = await chat({ chat_id: id, message: "[confirm] Run the approval extension." });
  assert.equal(interaction.statusCode, 409, interaction.body);
  assert.equal(interaction.json().error.code, "interaction_required");
  assert.equal(requests.length, before);
  const failed = await chat({ message: "[fail] Trigger a provider failure." });
  assert.equal(failed.statusCode, 502, failed.body);
  assert.match(failed.json().error.message, /: \S/, "upstream failures must carry the provider detail");
  assert.ok((await readFile(server.service.store.chat(id)!.session_file!, "utf8")).includes("first turn"));

  // Discover this project as a real Pi package, through Pi's loader rather than importing its factory directly.
  const packageRoot = process.env.PI_HTTP_TEST_PACKAGE ?? fileURLToPath(new URL("../../", import.meta.url));
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const probeAddress = portProbe.address();
  assert.ok(probeAddress && typeof probeAddress !== "string");
  const pluginPort = probeAddress.port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  await writeFile(join(root, "pi-http.config.json"), JSON.stringify({ server: { port: pluginPort },
    chat: { storage_dir: "./extension-data/chats" }, storage: { database_path: "./extension-data/state.sqlite" } }));
  await promisify(execFile)(process.execPath, [join(getPackageDir(), "dist/bundle/cli.js"), "install", packageRoot], {
    cwd: root, env: process.env, timeout: 10000,
  });
  const installed = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.ok(installed.packages.some((entry: string) => resolve(agentDir, entry) === resolve(packageRoot)));
  const ownerServices = await createAgentSessionServices({ cwd: root, extensionFlagValues: new Map([["http", true]]) });
  assert.deepEqual(ownerServices.diagnostics, []);
  await ownerServices.modelRuntime.setRuntimeApiKey("local-test", "fake-host-runtime-key");
  const { session: owner } = await createAgentSessionFromServices({ services: ownerServices,
    sessionManager: SessionManager.inMemory(root), model: ownerServices.modelRuntime.getModel("local-test", "model-b"), tools: ["read"] });
  const originalKey = process.env.PI_HTTP_API_KEY;
  process.env.PI_HTTP_API_KEY = "fake-service-key";
  let ownerError: string | undefined;
  try {
    await owner.bindExtensions({ mode: "print", onError: error => { ownerError = error.error; } });
    assert.equal(ownerError, undefined);
    const pluginUrl = `http://127.0.0.1:${pluginPort}`;
    const headers = { authorization: "Bearer fake-service-key", "content-type": "application/json" };
    const list = await fetch(`${pluginUrl}/v1/models`, { headers }).then(response => response.json()) as { default_model: string };
    assert.equal(list.default_model, "local-test/model-b");
    const result = await fetch(`${pluginUrl}/v1/chat`, { method: "POST", headers, body: JSON.stringify({ message: "from Pi extension" }) });
    assert.equal(result.status, 200, await result.clone().text());
    const body = await result.json() as { reply: string };
    assert.equal(body.reply, "reply:model-b");
    assert.deepEqual(requests.at(-1)!.tools?.map(tool => tool.function.name), ["read"]);
    assert.equal(authHeaders.at(-1), "Bearer fake-host-runtime-key");
    assert.equal(owner.messages.length, 0, "HTTP chats must not append to the user's interactive Pi conversation");
    const command = owner.extensionRunner.getCommand("http");
    assert.ok(command, "package must expose /http");
    await command.handler("start", owner.extensionRunner.createCommandContext());
    assert.equal((await fetch(`${pluginUrl}/v1/models`, { headers })).status, 200);
    await command.handler("stop", owner.extensionRunner.createCommandContext());
    await assert.rejects(fetch(`${pluginUrl}/v1/models`, { headers }));
    delete process.env.PI_HTTP_API_KEY;
    await command.handler("start", owner.extensionRunner.createCommandContext());
    await assert.rejects(fetch(`${pluginUrl}/v1/models`, { headers }));
    assert.equal(ownerError, undefined, "missing HTTP credentials must not break Pi itself");
    process.env.PI_HTTP_API_KEY = "fake-service-key";
    await command.handler("start", owner.extensionRunner.createCommandContext());
    assert.equal(ownerError, undefined);
    assert.equal((await fetch(`${pluginUrl}/v1/models`, { headers })).status, 200);
    await owner.setModel(ownerServices.modelRuntime.getModel("local-test", "model-a")!);
    const switched = await fetch(`${pluginUrl}/v1/models`, { headers }).then(response => response.json()) as { default_model: string };
    assert.equal(switched.default_model, "local-test/model-a");
    await owner.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    await assert.rejects(fetch(`${pluginUrl}/v1/models`, { headers }));
  } finally {
    await owner.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    owner.dispose();
    if (originalKey === undefined) delete process.env.PI_HTTP_API_KEY;
    else process.env.PI_HTTP_API_KEY = originalKey;
  }
  // OAuth providers must keep their stored credential: the host's runtime API key must not shadow it.
  const oauthHost = { cwd: root, isProjectTrusted: () => true, modelRegistry: {
    getAll: () => [], getProvider: () => undefined, isUsingOAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake-host-runtime-key" }),
  } } as unknown as ExtensionContext;
  const oauthBackend = await PiBackend.create(config, () => oauthHost);
  const oauthHandle = await oauthBackend.open({ sessionFile: null, model: { id: "local-test/model-a", name: "model-a", provider: "local-test" }, onSessionFile: () => {} });
  try {
    assert.equal(await oauthHandle.run("oauth turn", [], new AbortController().signal), "reply:model-a");
    assert.equal(authHeaders.at(-1), "Bearer fake-local-key", "OAuth providers must keep their stored credential");
  } finally { await oauthHandle.dispose(); }
  // Run the real Pi CLI headlessly through the packaged service adapter.
  const serviceConfig = join(root, "service.json");
  const serviceEnvironment = join(root, "environment.json");
  const serviceStatus = join(root, "status.json");
  await writeFile(serviceEnvironment, JSON.stringify({ PI_HTTP_API_KEY: "fake-service-key", PI_CODING_AGENT_DIR: agentDir,
    PATH: process.env.PATH ?? "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }));
  await writeFile(serviceConfig, JSON.stringify({ node: process.execPath, cwd: root,
    pi: [process.execPath, join(getPackageDir(), "dist/bundle/cli.js")], httpConfig: join(root, "pi-http.config.json"),
    environment: serviceEnvironment, status: serviceStatus, startupTimeout: 15, stopTimeout: 5 }));
  const launch = () => {
    const child = spawn(process.execPath, [join(packageRoot, "scripts/service.mjs"), "run", "--service-config", serviceConfig], {
      cwd: root, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", data => { logs += data; });
    child.stderr.on("data", data => { logs += data; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { child, exited, logs: () => logs };
  };
  const daemon = launch();
  try {
    const deadline = Date.now() + 18000;
    while (true) {
      const state = await readFile(serviceStatus, "utf8").then(JSON.parse).catch(() => null);
      if (state?.state === "ready") break;
      assert.equal(daemon.child.exitCode, null, daemon.logs());
      assert.ok(Date.now() < deadline, daemon.logs());
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const url = `http://127.0.0.1:${pluginPort}`;
    const headers = { authorization: "Bearer fake-service-key", "content-type": "application/json" };
    assert.equal((await fetch(`${url}/v1/models`, { headers })).status, 200);
    const result = await fetch(`${url}/v1/chat`, { method: "POST", headers, body: JSON.stringify({ message: "headless Pi [tool]" }) });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json() as { reply: string }).reply, "tool-ok");
    daemon.child.kill("SIGTERM");
    assert.equal(await daemon.exited, 0, daemon.logs());
    await assert.rejects(fetch(`${url}/v1/models`, { headers }));
    await assert.rejects(readFile(serviceStatus));
    assert.ok(!daemon.logs().includes("fake-service-key"));
  } finally {
    if (daemon.child.exitCode === null) { daemon.child.kill("SIGTERM"); await daemon.exited; }
  }
  const occupied = createServer();
  occupied.listen(pluginPort, "127.0.0.1");
  await once(occupied, "listening");
  try {
    const failed = launch();
    assert.equal(await failed.exited, 1, failed.logs());
    assert.match(failed.logs(), /failed to start/);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  process.stdout.write("Pi SDK integration passed\n");
} finally { await server.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
