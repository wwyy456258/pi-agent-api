#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { PiBackend } from "./pi-backend.js";
import { createApp } from "./app.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("Usage: pi-http [--config <path>]\nAuthentication: set PI_HTTP_API_KEY.\n");
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === "--config" && args[1])) {
    throw new Error("Usage: pi-http [--config <path>]");
  }
  const config = await loadConfig({ path: args[1] });
  const backend = await PiBackend.create(config);
  const server = await createApp(config, backend);
  const shutdown = () => { void server.close().catch(() => {
    process.stderr.write("pi-http: shutdown failed.\n"); process.exitCode = 1;
  }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const address = await server.app.listen({ host: config.server.host, port: config.server.port });
    process.stdout.write(`pi-http listening on ${address}\n`);
  } catch (error) { await server.close(); throw error; }
}

main().catch(error => {
  // Startup failures never print credentials or complete provider error objects.
  const message = error instanceof Error ? error.message : "Startup failed.";
  process.stderr.write(`pi-http: ${message.replaceAll(process.env.PI_HTTP_API_KEY || "\x00", "[redacted]")}\n`);
  process.exitCode = 1;
});
