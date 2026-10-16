import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { install, manage, servicePaths, renderService } from '../scripts/service.mjs';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../scripts/service.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-http-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('service installation generates private Linux/macOS definitions with correct escaping and no secrets', async t => {
  const root = await temporary(t);
  const cwd = join(root, 'Pi space % $ & " work');
  await mkdir(cwd);
  await writeFile(join(cwd, 'http.json'), JSON.stringify({ server: { shutdown_grace_seconds: 60 } }));
  const envFile = join(root, 'input.json');
  await writeFile(envFile, JSON.stringify({ PI_HTTP_API_KEY: 'test-secret', PROVIDER_API_KEY: 'provider-secret' }));
  for (const platform of ['linux', 'darwin']) {
    const paths = servicePaths(platform, join(root, platform), { configDir: join(root, platform, 'config'), logDir: join(root, platform, 'logs') });
    const calls = [];
    const execute = async (program, args) => {
      calls.push([program, ...args]);
      if (args[0] === 'print') throw Object.assign(new Error('not loaded'), { code: 113 });
      return { stdout: 'inactive\n' };
    };
    const config = await install({ cwd, httpConfig: join(cwd, 'http.json'), pi: process.execPath, envFile }, paths, execute);
    assert.equal(config.stopTimeout, 70);
    assert.deepEqual(config.pi, [process.execPath]);
    const definition = await readFile(paths.definition, 'utf8');
    assert.ok(!definition.includes('test-secret') && !definition.includes('provider-secret'));
    assert.equal((await stat(paths.environment)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.root)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(paths.environment, 'utf8')).PROVIDER_API_KEY, 'provider-secret');
    if (platform === 'linux') {
      assert.match(definition, /Restart=on-failure/);
      assert.match(definition, /WorkingDirectory=".*Pi space %% \$ & \\" work"/);
      assert.match(definition, /TimeoutStopSec=75/);
      assert.ok(calls.some(call => call.join(' ') === 'systemctl --user enable pi-http.service'));
    } else {
      assert.match(definition, /<key>SuccessfulExit<\/key><false\/>/);
      assert.match(definition, /&amp; &quot;/);
      if (process.platform === 'darwin') await exec('/usr/bin/plutil', ['-lint', paths.definition]);
    }
    await assert.rejects(install({ cwd, httpConfig: join(cwd, 'http.json'), pi: process.execPath, envFile, stopTimeout: '60' }, paths, execute), /greater than HTTP/);
  }
});

test('management selects user systemd/launchd commands, waits for readiness, and preserves configuration on uninstall', async t => {
  const root = await temporary(t);
  for (const platform of ['linux', 'darwin']) {
    const paths = servicePaths(platform, join(root, platform), { configDir: join(root, platform, 'config'), logDir: join(root, platform, 'logs') });
    await mkdir(paths.root, { recursive: true });
    await mkdir(dirname(paths.definition), { recursive: true });
    await writeFile(paths.config, JSON.stringify({ startupTimeout: 1, stopTimeout: 1 }));
    await writeFile(paths.environment, '{}');
    await writeFile(paths.definition, 'definition');
    let loaded = false;
    const calls = [];
    const execute = async (program, args) => {
      calls.push([program, ...args]);
      if (program === 'launchctl' && args[0] === 'print') {
        if (!loaded) throw Object.assign(new Error('not loaded'), { code: 113 });
      }
      if (args.includes('start') || args[0] === 'bootstrap') {
        loaded = true;
        await writeFile(paths.status, JSON.stringify({ pid: process.pid, state: 'ready' }));
      }
      if (args.includes('stop') || args[0] === 'bootout') { loaded = false; await rm(paths.status, { force: true }); }
      return { stdout: loaded ? 'active' : 'inactive' };
    };
    assert.equal((await manage('start', paths, execute)).state, 'ready');
    assert.equal((await manage('status', paths, execute)).loaded, true);
    assert.equal((await manage('restart', paths, execute)).state, 'ready');
    await manage('stop', paths, execute);
    assert.equal((await manage('status', paths, execute)).runtime, null);
    await manage('uninstall', paths, execute);
    assert.equal(await readFile(paths.environment, 'utf8'), '{}');
    await assert.rejects(readFile(paths.definition));
    if (platform === 'darwin') {
      assert.ok(calls.some(call => call[1] === 'bootstrap' && call[2] === `gui/${process.getuid()}`));
      assert.ok(calls.some(call => call[1] === 'bootout'));
    } else assert.ok(calls.some(call => call.join(' ') === 'systemctl --user reset-failed pi-http.service'));
  }
});

async function launchFake(t, mode) {
  const root = await temporary(t);
  const fake = join(root, 'fake-pi.mjs');
  await writeFile(fake, `import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const root = ${JSON.stringify(root)};
writeFileSync(root + '/argv.json', JSON.stringify(process.argv));
process.stdin.resume();
process.stdin.on('end', () => process.exit(9));
const mode = ${JSON.stringify(mode)};
if (mode === 'exit') process.exit(0);
if (mode === 'descendant') {
 const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio: ['ignore','inherit','inherit']});
 writeFileSync(root+'/descendant', String(descendant.pid));
 setTimeout(()=>process.exit(0), 30);
}
if (mode === 'error') process.stdout.write(JSON.stringify({type:'pi_http_service',token:process.env.PI_HTTP_SERVICE_READY_TOKEN,state:'error'})+'\\n');
if (['ready','ignoreterm'].includes(mode)) {
 process.stderr.write(process.env.PI_HTTP_API_KEY+'\\n');
 process.stdout.write(JSON.stringify({type:'pi_http_service',token:process.env.PI_HTTP_SERVICE_READY_TOKEN,state:'ready'})+'\\n');
}
if (mode === 'wrong-token') process.stdout.write(JSON.stringify({type:'pi_http_service',token:'wrong',state:'ready'})+'\\n');
process.on('SIGTERM', () => { if (mode !== 'ignoreterm') setTimeout(() => { writeFileSync(root+'/stopped','yes'); process.exit(0); }, 150); });
`);
  const config = join(root, 'service.json');
  const status = join(root, 'status.json');
  const environment = join(root, 'environment.json');
  await writeFile(environment, JSON.stringify({ PI_HTTP_API_KEY: 'secret-not-for-logs' }));
  await writeFile(config, JSON.stringify({ cwd: root, pi: [process.execPath, fake], httpConfig: join(root, 'http.json'),
    environment, status, startupTimeout: 1, stopTimeout: 1 }));
  const child = spawn(process.execPath, [launcher, 'run', '--service-config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const exit = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } });
  return { root, child, exit, status, logs: () => logs };
}
async function waitReady(launched) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await readFile(launched.status, 'utf8').then(JSON.parse).catch(() => null);
    if (state?.state === 'ready') return state;
    assert.equal(launched.child.exitCode, null, launched.logs());
    await pause(25);
  }
  assert.fail(launched.logs());
}

test('adapter holds RPC stdin open, confirms its own Pi startup, redacts keys and forwards graceful termination', { timeout: 10000 }, async t => {
  const launched = await launchFake(t, 'ready');
  const state = await waitReady(launched);
  await pause(200);
  assert.equal(launched.child.exitCode, null);
  const argv = JSON.parse(await readFile(join(launched.root, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--http') && argv.includes('--http-config') && argv.includes('-e'));
  assert.equal(argv[argv.indexOf('--mode') + 1], 'rpc');
  launched.child.kill('SIGTERM');
  assert.equal(await launched.exit, 0, launched.logs());
  assert.equal(await readFile(join(launched.root, 'stopped'), 'utf8'), 'yes');
  assert.ok(!launched.logs().includes('secret-not-for-logs'));
  assert.match(launched.logs(), /\[redacted\]/);
  await assert.rejects(readFile(launched.status));
  assert.throws(() => process.kill(state.child_pid, 0), { code: 'ESRCH' });
});

for (const mode of ['error', 'exit', 'silent', 'wrong-token', 'descendant']) {
  test(`adapter reports ${mode} startup as a failure for the OS manager`, { timeout: 10000 }, async t => {
    const launched = await launchFake(t, mode);
    assert.equal(await launched.exit, 1, launched.logs());
    await assert.rejects(readFile(launched.status));
    if (mode === 'descendant') {
      const pid = Number(await readFile(join(launched.root, 'descendant'), 'utf8'));
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); await pause(20); } catch { break; }
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  });
}

test('adapter forcefully terminates Pi after the graceful stop deadline', { timeout: 10000 }, async t => {
  const launched = await launchFake(t, 'ignoreterm');
  const state = await waitReady(launched);
  launched.child.kill('SIGTERM');
  assert.equal(await launched.exit, 1, launched.logs());
  assert.match(launched.logs(), /shutdown timed out/);
  assert.throws(() => process.kill(state.child_pid, 0), { code: 'ESRCH' });
});

test('unsupported platforms and ambiguous command options fail clearly', async () => {
  assert.throws(() => servicePaths('win32'), /Only Linux/);
  await assert.rejects(exec(process.execPath, [launcher, 'start', '--cwd', '/tmp']), /Options are only accepted/);
  const rendered = renderService({ node: '/a $b/%c/node', launcher: '/scripts/a.js', cwd: '/tmp', stopTimeout: 45 }, servicePaths('linux', '/tmp/u'));
  assert.match(rendered, /\/a \$\$b\/%%c\/node/);
});
