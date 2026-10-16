import { existsSync } from "node:fs";
import {
  createAgentSessionFromServices, createAgentSessionServices,
  createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionServices, ExtensionFactory, ExtensionUIContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import type { AgentBackend, AgentHandle, ModelInfo } from "./types.js";

type PiModel = ReturnType<AgentSessionServices["modelRuntime"]["getModel"]>;
const info = (model: NonNullable<PiModel>): ModelInfo => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider });

async function services(cwd: string): Promise<AgentSessionServices> {
  // SDK 1.3.0 exports the other three CLI factories. llama.cpp currently has no public factory export.
  const llama = await import(new URL("./extensions/llama/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as { default: ExtensionFactory };
  const factories: InlineExtension[] = [
    { name: "llama.cpp", factory: llama.default, builtin: true },
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
  ];
  const result = await createAgentSessionServices({ cwd, resourceLoaderOptions: { extensionFactories: factories } });
  if (result.diagnostics.some(item => item.type === "error") || result.resourceLoader.getExtensions().errors.length) {
    throw new ApiError(503, "service_unavailable", "Pi extension or provider configuration could not be loaded.");
  }
  return result;
}

export class PiBackend implements AgentBackend {
  private constructor(private config: Config, private catalog: AgentSessionServices, private piDefault: string | null) {}

  static async create(config: Config): Promise<PiBackend> {
    const catalog = await services(config.pi.cwd);
    const { session } = await createAgentSessionFromServices({ services: catalog, sessionManager: SessionManager.inMemory(config.pi.cwd) });
    const piDefault = session.model ? info(session.model).id : null;
    session.dispose();
    return new PiBackend(config, catalog, piDefault);
  }

  private find(id: string): PiModel {
    return this.catalog.modelRuntime.getModels().find(model => `${model.provider}/${model.id}` === id);
  }

  async resolveModel(explicit?: string): Promise<ModelInfo> {
    const id = explicit ?? this.config.model.default ?? this.piDefault;
    const model = id ? this.find(id) : undefined;
    if (!model || !this.catalog.modelRuntime.hasConfiguredAuth(model.provider)) {
      if (!explicit) throw new ApiError(503, "default_model_unavailable", "No usable default model is configured.");
      throw new ApiError(400, model ? "model_unavailable" : "model_not_found", model ? "The model has no configured credentials." : "The requested model does not exist.");
    }
    return info(model);
  }

  async models() {
    let defaultModel: string | null = null;
    try { defaultModel = (await this.resolveModel()).id; } catch (error) { if (!(error instanceof ApiError)) throw error; }
    return { default_model: defaultModel, models: this.catalog.modelRuntime.getAvailableSnapshot().map(info) };
  }

  async open(options: Parameters<AgentBackend["open"]>[0]): Promise<AgentHandle> {
    const runtime = await services(this.config.pi.cwd);
    const selected = runtime.modelRuntime.getModels().find(model => info(model).id === options.model.id);
    if (!selected) throw new ApiError(400, "model_unavailable", "The selected model is no longer available.");
    const manager = options.sessionFile && existsSync(options.sessionFile)
      ? SessionManager.open(options.sessionFile) : SessionManager.create(this.config.pi.cwd);
    const { session } = await createAgentSessionFromServices({ services: runtime, sessionManager: manager, model: selected });
    const file = manager.getSessionFile();
    if (file) options.onSessionFile(file);
    let interaction: ApiError | undefined;
    const noOp = () => {};
    const ui = new Proxy({} as ExtensionUIContext, {
      get(_target, property) {
        if (["select", "confirm", "input", "editor", "custom", "onTerminalInput"].includes(String(property))) {
          return () => {
            interaction = new ApiError(409, "interaction_required", "A Pi extension requires terminal interaction.");
            // Abort outside the awaited extension hook to avoid an idle/handler deadlock.
            queueMicrotask(() => { void session.abort().catch(noOp); });
            throw interaction;
          };
        }
        if (property === "getEditorText") return () => "";
        if (property === "getToolsExpanded") return () => false;
        if (property === "getAllThemes") return () => [];
        if (property === "setTheme") return () => ({ success: false, error: "No terminal UI is attached." });
        if (property === "getTheme" || property === "getEditorComponent") return () => undefined;
        return noOp;
      },
    });
    try {
      await session.bindExtensions({ uiContext: ui, mode: "print", onError: error => {
        if (interaction) interaction = new ApiError(409, "interaction_required", `Pi extension ${JSON.stringify(error.extensionPath)} requires terminal interaction.`);
      } });
      if (interaction) throw interaction;
    } catch (error) {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
      throw interaction ?? error;
    }

    return {
      async run(message, files, signal) {
        let reply = "";
        let upstreamFailed = false;
        const unsubscribe = session.subscribe(event => {
          if (event.type === "message_end" && event.message.role === "assistant") {
            upstreamFailed = event.message.stopReason === "error";
            reply = event.message.content.filter(item => item.type === "text").map(item => item.text).join("");
          }
        });
        const abort = () => { void session.abort().catch(noOp); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) throw new ApiError(409, "request_cancelled", "The original request was cancelled.");
          const attachmentText = files.length ? `\n\n[Uploaded attachments for this message; read only if needed]\n${JSON.stringify(files.map(({ name, path }) => ({ name, path })))}` : "";
          await session.prompt(message + attachmentText, { source: "rpc" });
          await session.waitForIdle();
          if (interaction) throw interaction;
          if (upstreamFailed) throw new ApiError(502, "upstream_error", "The model provider request failed.");
          return reply;
        } catch (error) {
          if (interaction) throw interaction;
          if (error instanceof ApiError) throw error;
          throw new ApiError(502, "upstream_error", "Pi could not complete the model request.");
        } finally { signal.removeEventListener("abort", abort); unsubscribe(); }
      },
      async dispose() {
        try {
          await session.abort();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally { session.dispose(); }
      },
    };
  }

  async close(): Promise<void> {}
}
