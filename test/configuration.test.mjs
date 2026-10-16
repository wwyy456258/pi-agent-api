import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG_PATH, defaultDatabasePath, initialize, readConfiguration, resolveDirectories } from '../scripts/configuration.mjs';
import { install, servicePaths } from '../scripts/service.mjs';

const temp = async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-api-init-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
};
test('initialization creates private configuration, key and directories without overwriting user changes', async t => {
  const root = await temp(t);
  const result = await initialize({ dataDir: join(root, 'nested/data') });
  const environment = await readFile(result.environmentPath, 'utf8');
  if (process.env.PI_HTTP_API_KEY?.trim()) assert.equal(JSON.parse(environment).PI_HTTP_API_KEY, process.env.PI_HTTP_API_KEY);
  else assert.match(JSON.parse(environment).PI_HTTP_API_KEY, /^[a-f0-9]{64}$/);
  assert.equal((await stat(result.environmentPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.configDir)).mode & 0o777, 0o700);
  for (const dir of [result.logDir, join(result.dataDir, 'chats')]) assert.ok((await stat(dir)).isDirectory());
  const raw = JSON.parse(await readFile(result.configPath, 'utf8'));
  raw.server.port = 53000;
  await writeFile(result.configPath, JSON.stringify(raw));
  await initialize({ dataDir: result.dataDir });
  assert.equal(JSON.parse(await readFile(result.configPath, 'utf8')).server.port, 53000);
  assert.equal(await readFile(result.environmentPath, 'utf8'), environment);
});
test('default root, custom directory resolution and explicit configuration precedence are consistent', async t => {
  const root = await temp(t);
  assert.equal(DEFAULT_CONFIG_PATH, '/data/pi-agent-api/config/pi-agent-api.config.json');
  assert.deepEqual(resolveDirectories({}, join(root, 'main.json')), { dataDir: '/data/pi-agent-api', configDir: '/data/pi-agent-api/config', logDir: '/data/pi-agent-api/logs' });
  const custom = { paths: { data_dir: './custom', config_dir: './settings' }, logging: { directory: './logs' } };
  const explicit = join(root, 'explicit.json');
  await writeFile(explicit, JSON.stringify(custom));
  await writeFile(join(root, 'pi-agent-api.config.json'), '{}');
  assert.equal((await readConfiguration({ cwd: root })).configPath, join(root, 'pi-agent-api.config.json'));
  const loaded = await readConfiguration({ cwd: root, path: explicit });
  assert.deepEqual(resolveDirectories(loaded.raw, loaded.configPath), { dataDir: join(root, 'custom'), configDir: join(root, 'settings'), logDir: join(root, 'logs') });
  await assert.rejects(readConfiguration({ cwd: root, path: 'absent.json' }), { code: 'ENOENT' });
});
test('CLI init and service installation share configurable paths and the generated environment file', async t => {
  const root = await temp(t);
  const cli = fileURLToPath(new URL('../scripts/service.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'init', '--data-dir', root]);
  assert.ok(!stdout.includes('PI_HTTP_API_KEY'));
  const configPath = join(root, 'config/pi-agent-api.config.json');
  const paths = servicePaths('linux', root, resolveDirectories(JSON.parse(await readFile(configPath, 'utf8')), configPath));
  const config = await install({ cwd: root, httpConfig: configPath, pi: process.execPath }, paths, async () => ({ stdout: 'inactive' }));
  assert.equal(config.environment, join(root, 'config/environment.json'));
  assert.equal(config.httpConfig, configPath);
  assert.ok((await stat(join(root, 'logs'))).isDirectory());
});
test('initialization reports an unusable directory instead of falling back elsewhere', async t => {
  const root = await temp(t);
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'file');
  await assert.rejects(initialize({ dataDir: file }), /Cannot create directory.*Configure a writable path/);
});

test('init without path options preserves the existing working-directory configuration', async t => {
  const root = await temp(t);
  const path = join(root, 'pi-agent-api.config.json');
  const existing = JSON.stringify({ paths: { data_dir: root }, server: { port: 53000 } });
  await writeFile(path, existing);
  const result = await initialize({ cwd: root });
  assert.equal(result.configPath, path);
  assert.equal(await readFile(path, 'utf8'), existing);
  assert.equal(result.dataDir, root);
});

test('legacy config preserves paths and credentials while the new filename takes precedence', async t => {
  const root = await temp(t);
  const legacy = join(root, 'pi-http.config.json');
  const current = join(root, 'pi-agent-api.config.json');
  assert.equal(resolveDirectories({}, legacy).dataDir, '/data/pi-http');
  assert.equal(defaultDatabasePath(root, legacy), join(root, 'pi-http.sqlite'));
  assert.equal(defaultDatabasePath(root, current), join(root, 'pi-agent-api.sqlite'));
  const oldConfig = JSON.stringify({ paths: { data_dir: root }, server: { port: 53000 } });
  await writeFile(legacy, oldConfig);
  const initialized = await initialize({ cwd: root });
  const environment = await readFile(initialized.environmentPath, 'utf8');
  assert.equal(initialized.configPath, legacy);
  assert.equal(await readFile(legacy, 'utf8'), oldConfig);
  await initialize({ cwd: root });
  assert.equal(await readFile(initialized.environmentPath, 'utf8'), environment);
  await writeFile(current, JSON.stringify({ paths: { data_dir: join(root, 'new') } }));
  assert.equal((await readConfiguration({ cwd: root })).configPath, current);
  assert.equal((await readConfiguration({ cwd: root, path: legacy })).configPath, legacy);
});

test('initializing an existing legacy data directory reuses its configuration and key', async t => {
  const root = await temp(t);
  await mkdir(join(root, 'config'));
  const path = join(root, 'config/pi-http.config.json');
  const environmentPath = join(root, 'config/environment.json');
  const config = JSON.stringify({ paths: { data_dir: root }, server: { port: 53000 } });
  const environment = JSON.stringify({ PI_HTTP_API_KEY: 'existing-service-key' });
  await writeFile(path, config);
  await writeFile(environmentPath, environment);
  const result = await initialize({ dataDir: root });
  assert.equal(result.configPath, path);
  assert.equal(await readFile(path, 'utf8'), config);
  assert.equal(await readFile(environmentPath, 'utf8'), environment);
  await assert.rejects(readFile(join(root, 'config/pi-agent-api.config.json')), { code: 'ENOENT' });
});
