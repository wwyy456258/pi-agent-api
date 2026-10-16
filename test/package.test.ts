import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

test("packed extension installs and runs with host-provided Pi SDK and production dependencies only", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-http-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = fileURLToPath(new URL("../", import.meta.url));
  const exec = promisify(execFile);
  const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(directory, "npm-cache"), "--pack-destination", directory], { cwd: project, timeout: 15000 });
  const artifact = (JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[])[0]!;
  assert.ok(artifact.files.some(file => file.path === "src/extension.ts"));
  assert.ok(artifact.files.some(file => file.path === "LICENSE"));
  assert.ok(artifact.files.some(file => file.path === "docs/publishing.md"));
  assert.ok(artifact.files.every(file => !file.path.startsWith("node_modules/") && !file.path.startsWith("data/") && !file.path.startsWith("dist/") && !["pi-http.config.json", ".env", "src/cli.ts"].includes(file.path)));
  await exec("tar", ["-xzf", join(directory, artifact.filename), "-C", directory]);
  const extension = join(directory, "package");
  const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/");
  assert.equal(manifest.bin["pi-http-service"], "scripts/service.mjs");
  assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  // Link exactly the declared runtime dependencies. Pi itself is intentionally absent.
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = join(extension, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(await realpath(join(project, "node_modules", name)), destination, "dir");
  }
  assert.equal(existsSync(join(extension, "node_modules/@earendil-works/pi-coding-agent")), false);
  const serviceBin = join(directory, "pi-http-service");
  await symlink(join(extension, "scripts/service.mjs"), serviceBin);
  const help = await exec(process.execPath, [serviceBin, "--help"]);
  assert.match(help.stdout, /systemd/);
  const runtime = join(directory, "runtime");
  await mkdir(runtime);
  const result = await exec(process.execPath, ["--import", "tsx", join(project, "test/fixtures/pi-check.ts"), runtime], {
    cwd: project, timeout: 40000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      PI_CODING_AGENT_DIR: join(runtime, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_HTTP_TEST_PACKAGE: extension },
  });
  assert.match(result.stdout, /Pi SDK integration passed/);
});
