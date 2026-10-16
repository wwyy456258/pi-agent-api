// Optional native test. Creates one uniquely named job, then always boots it out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderService, servicePaths, writePrivate } from '../scripts/service.mjs';
const exec = promisify(execFile);
const waitFor = async (operation, seconds = 30) => {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for native launchd state.');
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('native launchd restarts a crashed adapter, reaps its Pi process and supports graceful bootout', {
  skip: process.platform !== 'darwin' || process.env.PI_HTTP_TEST_LAUNCHD !== '1', timeout: 60000,
}, async t => {
  const root = await mkdtemp('/private/tmp/pi-http-launchd-test-');
  const uniqueLabel = `dev.pi-http.test.${randomUUID()}`;
  const target = `gui/${process.getuid()}/${uniqueLabel}`;
  let loaded = false;
  t.after(async () => {
    if (loaded) await exec('launchctl', ['bootout', target], { timeout: 10000 });
    await rm(root, { recursive: true, force: true });
  });
  const paths = servicePaths('darwin', root, { configDir: join(root, 'config'), logDir: join(root, 'logs') });
  await mkdir(paths.root, { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  const fake = join(root, 'pi.mjs');
  await writeFile(fake, `import {writeFileSync} from 'node:fs';
process.stdin.resume();
process.stdin.on('end', ()=>process.exit(9));
process.stderr.write(JSON.stringify({type:'pi_http_service',token:process.env.PI_HTTP_SERVICE_READY_TOKEN,state:'ready'})+'\\n');
process.on('SIGTERM', ()=>{writeFileSync(${JSON.stringify(join(root, 'stopped-'))}+process.pid,'yes');setTimeout(()=>process.exit(0),100);});
`);
  const config = { version: 1, platform: 'darwin', node: process.execPath,
    launcher: fileURLToPath(new URL('../scripts/service.mjs', import.meta.url)), cwd: root,
    pi: [process.execPath, fake], httpConfig: join(root, 'http.json'), environment: paths.environment,
    status: paths.status, startupTimeout: 5, stopTimeout: 2 };
  await writePrivate(paths.environment, JSON.stringify({ PI_HTTP_API_KEY: 'native-test-key' }));
  await writePrivate(paths.config, JSON.stringify(config));
  const definition = join(root, 'job.plist');
  await writeFile(definition, renderService(config, paths).replaceAll('dev.pi-http', uniqueLabel));
  await exec('launchctl', ['bootstrap', `gui/${process.getuid()}`, definition], { timeout: 10000 });
  loaded = true;
  const state = () => readFile(paths.status, 'utf8').then(JSON.parse).catch(() => null);
  const first = await waitFor(async () => { const s = await state(); return s?.state === 'ready' && s; });
  process.kill(first.pid, 'SIGKILL');
  await waitFor(() => !alive(first.child_pid), 5);
  const second = await waitFor(async () => {
    const s = await state(); return s?.state === 'ready' && s.pid !== first.pid && alive(s.pid) && s;
  });
  assert.notEqual(first.child_pid, second.child_pid);
  await exec('launchctl', ['bootout', target], { timeout: 10000 });
  loaded = false;
  await waitFor(() => !alive(second.pid) && !alive(second.child_pid), 10);
  assert.equal(await readFile(join(root, `stopped-${second.child_pid}`), 'utf8'), 'yes');
});
