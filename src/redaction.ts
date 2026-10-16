/** Keep actionable errors without copying known credentials into logs or HTTP errors. */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).filter(([name, value]) => /key|token|password|secret/i.test(name) && Boolean(value))
    .map(([, value]) => value!);
}
export function redact(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, "[redacted]");
  return result.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&\s"']+/gi, "$1[redacted]");
}
