import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { ApiError, envelope } from "./errors.js";

export interface ChatRow {
  id: string;
  session_file: string | null;
  ttl: number;
  expires_at: number;
  expired: number;
  cleaned: number;
}

export interface RequestRow {
  id: string;
  key_hash: string | null;
  chat_id: string;
  fingerprint: string | null;
  state: string;
  status: number | null;
  body: string | null;
}

export class Store {
  private constructor(private db: DatabaseSync, private release: () => Promise<void>) {}

  static async open(path: string): Promise<Store> {
    await mkdir(dirname(path), { recursive: true });
    await (await open(path, "a", 0o600)).close();
    const release = await lockfile.lock(path, {
      stale: 10000, update: 2000,
      retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000, randomize: false },
    });
    try {
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY, session_file TEXT, ttl INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0,
          cleaned INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, key_hash TEXT UNIQUE, chat_id TEXT NOT NULL REFERENCES chats(id),
          fingerprint TEXT, state TEXT NOT NULL, status INTEGER, body TEXT
        );
        CREATE INDEX IF NOT EXISTS requests_chat ON requests(chat_id);
        CREATE INDEX IF NOT EXISTS chats_expiration ON chats(expired, expires_at);
      `);
      return new Store(db, release);
    } catch (error) { await release(); throw error; }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  chat(id: string): ChatRow | undefined {
    return this.db.prepare("SELECT * FROM chats WHERE id=?").get(id) as unknown as ChatRow | undefined;
  }

  requestByKey(hash: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE key_hash=?").get(hash) as unknown as RequestRow | undefined;
  }

  submit(options: { requestId: string; chatId: string; keyHash: string | null;
    fingerprint: string; ttl: number; isNew: boolean; now: number }): void {
    this.transaction(() => {
      if (options.isNew) {
        this.db.prepare("INSERT INTO chats(id,ttl,expires_at) VALUES(?,?,?)")
          .run(options.chatId, options.ttl, options.now + options.ttl * 1000);
      }
      this.db.prepare("INSERT INTO requests(id,key_hash,chat_id,fingerprint,state) VALUES(?,?,?,?, 'running')")
        .run(options.requestId, options.keyHash, options.chatId, options.fingerprint);
    });
  }

  setSession(id: string, path: string): void {
    this.db.prepare("UPDATE chats SET session_file=? WHERE id=?").run(path, id);
  }

  finish(requestId: string, chatId: string, status: number, body: unknown, expiresAt: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE requests SET state='finished',status=?,body=? WHERE id=?")
        .run(status, JSON.stringify(body), requestId);
      this.db.prepare("UPDATE chats SET expires_at=? WHERE id=?").run(expiresAt, chatId);
    });
  }

  recover(now: number): void {
    this.transaction(() => {
      const unfinished = this.db.prepare("SELECT * FROM requests WHERE state='running'").all() as unknown as RequestRow[];
      for (const request of unfinished) {
        const error = new ApiError(409, "request_interrupted", "The original request was interrupted by a service restart.");
        this.db.prepare("UPDATE requests SET state='finished',status=409,body=? WHERE id=?")
          .run(JSON.stringify(envelope(error, request.id, request.chat_id)), request.id);
        this.db.prepare("UPDATE chats SET expires_at=? + ttl * 1000 WHERE id=? AND expired=0")
          .run(now, request.chat_id);
      }
    });
  }

  expirationCandidates(now: number): ChatRow[] {
    return this.db.prepare("SELECT * FROM chats WHERE (expired=0 AND expires_at<=?) OR (expired=1 AND cleaned=0)")
      .all(now) as unknown as ChatRow[];
  }

  expire(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE chats SET expired=1,session_file=NULL,ttl=0 WHERE id=?").run(id);
      this.db.prepare("DELETE FROM requests WHERE chat_id=? AND key_hash IS NULL").run(id);
      this.db.prepare("UPDATE requests SET state='expired',fingerprint=NULL,status=NULL,body=NULL WHERE chat_id=?").run(id);
    });
  }

  markCleaned(id: string): void {
    this.db.prepare("UPDATE chats SET cleaned=1 WHERE id=?").run(id);
  }

  async close(): Promise<void> { this.db.close(); await this.release(); }
}
