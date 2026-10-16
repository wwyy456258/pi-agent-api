import { open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ensureDirectory } from "../scripts/configuration.mjs";
import { knownSecrets, redact } from "./redaction.ts";

/** One ordered writer per HTTP listener. No request headers or attachment contents are logged. */
export class HttpLog {
  private queue: Promise<void> = Promise.resolve();
  private bytes = 0;
  private file?: FileHandle;
  private closed = false;
  private constructor(private config: Config, readonly path: string, private secrets: string[]) {}
  static async open(config: Config): Promise<HttpLog> {
    const log = new HttpLog(config, join(config.logging.directory, "http.jsonl"), [config.apiKey, ...knownSecrets()]);
    if (config.logging.enabled) {
      await ensureDirectory(config.logging.directory);
      log.file = await open(log.path, "a", 0o600);
      log.bytes = (await log.file.stat()).size;
    }
    return log;
  }
  body(value: unknown): unknown {
    if (!this.config.logging.enabled || !this.config.logging.log_bodies || value === undefined) return undefined;
    const text = redact(JSON.stringify(value, (key, item: unknown) =>
      /authorization|api[_-]?key|access[_-]?token|password|secret/i.test(key) ? "[redacted]" : typeof item === "string" ? redact(item, this.secrets) : item), this.secrets);
    if (text.length > this.config.logging.max_body_chars) return {
      truncated: true, original_chars: text.length, preview: text.slice(0, this.config.logging.max_body_chars),
    };
    return JSON.parse(text) as unknown;
  }
  record(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!this.file || this.closed) return Promise.resolve();
    const line = `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`;
    const operation = this.queue.then(async () => {
      if (!this.file || this.file.fd < 0) {
        this.file = await open(this.path, "a", 0o600);
        this.bytes = (await this.file.stat()).size;
      }
      if (this.bytes && this.bytes + Buffer.byteLength(line) > this.config.logging.max_file_bytes) {
        await this.file!.close();
        await rm(`${this.path}.${this.config.logging.max_files}`, { force: true });
        for (let index = this.config.logging.max_files - 1; index >= 1; index--) {
          try { await rename(`${this.path}.${index}`, `${this.path}.${index + 1}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await rename(this.path, `${this.path}.1`);
        this.file = await open(this.path, "a", 0o600);
        this.bytes = 0;
      }
      await this.file!.writeFile(line);
      this.bytes += Buffer.byteLength(line);
    });
    this.queue = operation.catch(error => {
      process.stderr.write(`${new Date().toISOString()} pi-http: logging failed (${(error as NodeJS.ErrnoException).code ?? "unknown"}) at ${this.path}\n`);
    });
    return this.queue;
  }
  async flush(): Promise<void> { await this.queue; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.file?.close();
  }
}
