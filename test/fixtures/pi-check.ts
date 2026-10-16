import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { PiBackend } from "../../src/pi-backend.js";

const root = process.argv[2]!;
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
const toolFile = join(root, "reference.txt");
await writeFile(toolFile, "local-tool-evidence");
const provider = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const user = body.messages.filter((message: { role: string }) => message.role === "user").at(-1);
    const toolCall = JSON.stringify(user?.content).includes("[tool]") && body.messages.at(-1)?.role !== "tool";
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
  assert.ok((await readFile(server.service.store.chat(id)!.session_file!, "utf8")).includes("first turn"));
  process.stdout.write("Pi SDK integration passed\n");
} finally { await server.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
