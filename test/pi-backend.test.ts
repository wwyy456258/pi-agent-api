import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("real Pi SDK and package loader verify chat, tools, /http lifecycle and inherited host credentials", { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-api-sdk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./fixtures/pi-check.ts", import.meta.url)), directory], {
      timeout: 40000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    });
  assert.match(result.stdout, /Pi SDK integration passed/);
});
