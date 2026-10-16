export interface ChatInput {
  message: string;
  chat_id?: string;
  model?: string;
  ttl_seconds?: number;
}

export interface Attachment {
  name: string;
  path: string;
  sha256: string;
  size: number;
}

export interface ChatResult {
  request_id: string;
  chat_id: string;
  model: string;
  reply: string;
  expires_at: string;
}

export interface ModelInfo { id: string; name: string; provider: string }

export interface AgentHandle {
  run(message: string, files: Attachment[], signal: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

export interface AgentBackend {
  models(): Promise<{ default_model: string | null; models: ModelInfo[] }>;
  resolveModel(model?: string): Promise<ModelInfo>;
  open(options: {
    sessionFile: string | null;
    model: ModelInfo;
    onSessionFile: (path: string) => void;
  }): Promise<AgentHandle>;
  close(): Promise<void>;
}
