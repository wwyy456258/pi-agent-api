import { validTtl } from "./config.js";
import { invalid } from "./errors.js";
import type { ChatInput } from "./types.js";

export function parseInput(value: unknown): ChatInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("The request must be an object.");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!["message", "chat_id", "model", "ttl_seconds"].includes(key)) invalid(`Unknown field: ${key}`);
  }
  if (typeof body.message !== "string" || !body.message.trim()) invalid("message must be a non-empty string.");
  for (const key of ["chat_id", "model"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || !body[key].trim())) {
      invalid(`${key} must be a non-empty string.`);
    }
  }
  if (body.ttl_seconds !== undefined && !validTtl(body.ttl_seconds)) invalid("ttl_seconds must be a positive integer within the timestamp range.");
  if (body.chat_id !== undefined && body.ttl_seconds !== undefined) invalid("ttl_seconds is only accepted when creating a chat.");
  return body as unknown as ChatInput;
}
