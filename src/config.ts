import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface Config {
  apiKey: string;
  server: { host: string; port: number; shutdown_grace_seconds: number };
  pi: { cwd: string };
  model: { default?: string };
  chat: { storage_dir: string; ttl_seconds: number; cleanup_interval_seconds: number };
  storage: { database_path: string };
  upload: { max_file_bytes: number; max_request_bytes: number; max_files: number };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown configuration field: ${label}${key}`);
  }
}

export function validTtl(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 &&
    Date.now() + (value as number) * 1000 <= 8_640_000_000_000_000;
}

export async function loadConfig(options: {
  path?: string; cwd?: string; env?: NodeJS.ProcessEnv;
} = {}): Promise<Config> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.path ?? "pi-http.config.json");
  let raw: Record<string, unknown> = {};
  let base = cwd;
  try {
    raw = object(JSON.parse(await readFile(configPath, "utf8")), "config");
    base = dirname(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.path) throw error;
  }
  keys(raw, ["server", "pi", "model", "chat", "storage", "upload"], "");
  const section = (name: string, allowed: string[]) => {
    const value = raw[name] === undefined ? {} : object(raw[name], name);
    keys(value, allowed, `${name}.`);
    return value;
  };
  const server = section("server", ["host", "port", "shutdown_grace_seconds"]);
  const pi = section("pi", ["cwd"]);
  const model = section("model", ["default"]);
  const chat = section("chat", ["storage_dir", "ttl_seconds", "cleanup_interval_seconds"]);
  const storage = section("storage", ["database_path"]);
  const upload = section("upload", ["max_file_bytes", "max_request_bytes", "max_files"]);
  const str = (value: unknown, fallback: string, label: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
    return value;
  };
  const num = (value: unknown, fallback: number, label: string, min = 0): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${label} must be an integer >= ${min}.`);
    return value as number;
  };
  const apiKey = (options.env ?? process.env).PI_HTTP_API_KEY;
  if (!apiKey?.trim()) throw new Error("PI_HTTP_API_KEY is required.");
  const ttl = num(chat.ttl_seconds, 86400, "chat.ttl_seconds", 1);
  if (!validTtl(ttl)) throw new Error("chat.ttl_seconds is outside the supported timestamp range.");
  const interval = num(chat.cleanup_interval_seconds, 300, "chat.cleanup_interval_seconds", 1);
  const grace = num(server.shutdown_grace_seconds, 30, "server.shutdown_grace_seconds");
  if (interval * 1000 > 2_147_483_647 || grace * 1000 > 2_147_483_647) {
    throw new Error("Cleanup interval or shutdown grace exceeds the supported timer range.");
  }
  const port = num(server.port, 3000, "server.port", 1);
  if (port > 65535) throw new Error("server.port must be <= 65535.");
  return {
    apiKey,
    server: { host: str(server.host, "127.0.0.1", "server.host"), port, shutdown_grace_seconds: grace },
    pi: { cwd: pi.cwd === undefined ? cwd : resolve(base, str(pi.cwd, cwd, "pi.cwd")) },
    model: model.default === undefined ? {} : { default: str(model.default, "", "model.default") },
    chat: { storage_dir: resolve(base, str(chat.storage_dir, "./data/chats", "chat.storage_dir")),
      ttl_seconds: ttl, cleanup_interval_seconds: interval },
    storage: { database_path: resolve(base, str(storage.database_path, "./data/pi-http.sqlite", "storage.database_path")) },
    upload: {
      max_file_bytes: num(upload.max_file_bytes, 0, "upload.max_file_bytes"),
      max_request_bytes: num(upload.max_request_bytes, 0, "upload.max_request_bytes"),
      max_files: num(upload.max_files, 0, "upload.max_files"),
    },
  };
}
