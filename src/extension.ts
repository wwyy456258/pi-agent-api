import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { PiBackend } from "./pi-backend.ts";

type Server = Awaited<ReturnType<typeof createApp>>;

/** Registered once by Pi; HTTP child sessions filter this extension from their resource loader. */
export default function piHttp(pi: ExtensionAPI): void {
  let server: Server | undefined;
  let address: string | undefined;
  let transition: Promise<void> = Promise.resolve();
  let latestContext: ExtensionContext | undefined;

  // Private stderr JSONL handshake for the service launcher, isolated from ordinary Pi use.
  const serviceStatus = (state: "ready" | "error", listeningAddress?: string) => {
    const token = process.env.PI_HTTP_SERVICE_READY_TOKEN;
    if (token) process.stderr.write(`${JSON.stringify({ type: "pi_http_service", token, state, address: listeningAddress })}\n`);
  };

  const report = (ctx: ExtensionContext, message: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
    else process.stderr.write(`${message}\n`);
  };
  const serialized = (operation: () => Promise<void>) => {
    const next = transition.then(operation);
    transition = next.catch(() => {});
    return next;
  };
  const stop = () => serialized(async () => {
    const current = server;
    server = undefined;
    address = undefined;
    if (current) await current.close();
  });
  const start = (ctx: ExtensionContext) => serialized(async () => {
    if (server) { report(ctx, `pi-http is already listening on ${address}`); return; }
    latestContext = ctx;
    const flag = pi.getFlag("http-config");
    const config = await loadConfig({ cwd: ctx.cwd, path: typeof flag === "string" ? flag : undefined });
    const backend = await PiBackend.create(config, () => latestContext!, () => pi.getActiveTools());
    let next: Server;
    try { next = await createApp(config, backend); }
    catch (error) { await backend.close(); throw error; }
    try {
      address = await next.app.listen({ host: config.server.host, port: config.server.port });
      server = next;
      report(ctx, `pi-http listening on ${address}`);
      serviceStatus("ready", address);
    } catch (error) { await next.close(); throw error; }
  });
  const displayFailure = (ctx: ExtensionContext, error: unknown) => {
    const key = process.env.PI_HTTP_API_KEY;
    const raw = error instanceof Error ? error.message : "HTTP extension operation failed.";
    report(ctx, `pi-http: ${key ? raw.replaceAll(key, "[redacted]") : raw}`, true);
  };

  pi.registerFlag("http", { description: "Start the pi-http listener with this Pi session", type: "boolean", default: false });
  pi.registerFlag("http-config", { description: "Path to pi-http.config.json", type: "string" });
  pi.registerCommand("http", {
    description: "Manage the HTTP listener: /http start | stop | status",
    handler: async (args, ctx) => {
      latestContext = ctx;
      try {
        switch (args.trim()) {
          case "start": await start(ctx); break;
          case "stop": await stop(); report(ctx, "pi-http stopped."); break;
          case "":
          case "status": await transition; report(ctx, server ? `pi-http listening on ${address}` : "pi-http is stopped."); break;
          default: report(ctx, "Usage: /http start | stop | status", true);
        }
      } catch (error) { displayFailure(ctx, error); }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    if (pi.getFlag("http") === true) {
      try { await start(ctx); } catch (error) { displayFailure(ctx, error); serviceStatus("error"); }
    }
  });
  pi.on("model_select", (_event, ctx) => { latestContext = ctx; });
  pi.on("session_shutdown", async () => { await stop(); });
}
