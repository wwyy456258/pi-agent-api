#!/usr/bin/env node
// This executable only manages OS services and supervises the actual Pi CLI.
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { DEFAULT_DATA_DIR, LEGACY_DATA_DIR, ensureDirectory, initialize, readConfiguration, resolveDirectories } from './configuration.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(script));
const label = 'dev.pi-agent-api';
const unit = 'pi-agent-api.service';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const exists = async path => { try { await access(path); return true; } catch { return false; } };

export function servicePaths(platform = process.platform, home = homedir(), directories = {}, legacy = false) {
  const serviceUnit = legacy ? 'pi-http.service' : unit;
  const serviceLabel = legacy ? 'dev.pi-http' : label;
  if (!['linux', 'darwin'].includes(platform)) throw new Error('Only Linux (systemd) and macOS (launchd) are supported.');
  const root = directories.configDir ?? join(legacy ? LEGACY_DATA_DIR : DEFAULT_DATA_DIR, 'config');
  const logDir = directories.logDir ?? join(legacy ? LEGACY_DATA_DIR : DEFAULT_DATA_DIR, 'logs');
  return { platform, root, unit: serviceUnit, label: serviceLabel, config: join(root, 'service.json'), environment: join(root, 'environment.json'),
    status: join(root, 'status.json'), log: join(logDir, 'service.log'),
    definition: platform === 'linux' ? join(home, '.config/systemd/user', serviceUnit) : join(home, 'Library/LaunchAgents', `${serviceLabel}.plist`) };
}

export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
const json = async path => {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${path}.`); }
};
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
// systemd performs its own %-specifier and $-environment expansion, even inside quotes.
const systemdArg = (value, expandEnvironment = true) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => expandEnvironment ? '$$' : '$').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`;
const domain = () => `gui/${process.getuid()}`;

export function renderService(config, paths) {
  const args = [config.node, config.launcher, 'run', '--service-config', paths.config];
  if (paths.platform === 'linux') return `[Unit]\nDescription=pi-agent-api (Pi HTTP extension)\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${systemdArg(config.cwd, false)}\nExecStart=${args.map(arg => systemdArg(arg)).join(' ')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=${config.stopTimeout + 5}\nKillMode=mixed\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${paths.label}</string>\n<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(config.cwd)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>${config.stopTimeout + 5}</integer>\n<key>ProcessType</key><string>Background</string>\n<key>AbandonProcessGroup</key><false/>\n<key>StandardOutPath</key><string>${xml(paths.log)}</string>\n<key>StandardErrorPath</key><string>${xml(paths.log)}</string>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`;
}

export async function resolvePi(command, env = process.env) {
  const candidates = command.includes('/') ? [resolve(command)] : (env.PATH ?? '').split(delimiter).map(dir => join(dir || '.', command));
  for (const path of candidates) {
    try {
      const absolute = await realpath(path);
      await access(absolute, /\.[cm]?js$/.test(absolute) ? constants.R_OK : constants.X_OK);
      return /\.[cm]?js$/.test(absolute) ? [process.execPath, absolute] : [absolute];
    } catch { /* Continue PATH lookup. */ }
  }
  throw new Error(`Pi executable not found: ${command}. Use --pi /absolute/path/to/pi.`);
}

function environmentMap(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([key, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== 'string' || v.includes('\0'))) {
    throw new Error('Environment file must be a JSON object containing string environment variables.');
  }
  if (!value.PI_HTTP_API_KEY?.trim()) throw new Error('PI_HTTP_API_KEY is required (export it or supply --env-file).');
  delete value.PI_HTTP_SERVICE_READY_TOKEN;
  return value;
}

export async function install(options, paths, execute = exec) {
  const loadedConfig = await readConfiguration({ path: options.httpConfig, cwd: options.cwd });
  const http = loadedConfig.raw;
  paths ??= servicePaths(process.platform, homedir(), resolveDirectories(http, loadedConfig.configPath));
  const previousDefinition = join(dirname(paths.definition), paths.platform === 'linux' ? 'pi-http.service' : 'dev.pi-http.plist');
  if (await exists(previousDefinition)) throw new Error('Remove the legacy service before installing pi-agent-api: run pi-agent-api-service uninstall --legacy-service with its --http-config path. Configuration and data are preserved.');
  // Refuse replacing a running job: its configuration and stop timeout must stay consistent.
  if (await isLoaded(paths, execute)) throw new Error('Stop the service before installing or updating it.');
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const environment = environmentMap({
    ...(await exists(paths.environment) ? await json(paths.environment) : {}),
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: resolve(process.env.PI_CODING_AGENT_DIR) } : {}),
    ...(process.env.PI_HTTP_API_KEY ? { PI_HTTP_API_KEY: process.env.PI_HTTP_API_KEY } : {}),
    ...(options.envFile ? await json(resolve(options.envFile)) : {}),
  });
  if (environment.PI_CODING_AGENT_DIR && !isAbsolute(environment.PI_CODING_AGENT_DIR)) throw new Error('PI_CODING_AGENT_DIR must be absolute.');
  const httpConfig = loadedConfig.configPath;
  await access(httpConfig); // initialize explicitly, never install a silently unconfigured job
  const grace = http.server?.shutdown_grace_seconds ?? 30;
  if (!Number.isInteger(grace) || grace < 0) throw new Error('Invalid server.shutdown_grace_seconds.');
  const startupTimeout = Number(options.startupTimeout ?? 60);
  const stopTimeout = Number(options.stopTimeout ?? Math.max(45, grace + 10));
  if (!Number.isInteger(startupTimeout) || startupTimeout < 1 || startupTimeout > 3600 ||
      !Number.isInteger(stopTimeout) || stopTimeout <= grace || stopTimeout > 86400) {
    throw new Error('Timeouts must be integer seconds; startup: 1..3600, stop: greater than HTTP shutdown grace and at most 86400.');
  }
  const config = { version: 1, node: process.execPath, launcher: script, cwd, httpConfig,
    pi: await resolvePi(options.pi ?? 'pi', environment), startupTimeout, stopTimeout,
    environment: paths.environment, status: paths.status, platform: paths.platform };
  await ensureDirectory(paths.root);
  await ensureDirectory(dirname(paths.log));
  await chmod(paths.root, 0o700);
  await writePrivate(paths.environment, `${JSON.stringify(environment, null, 2)}\n`);
  await writePrivate(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  await writePrivate(paths.definition, renderService(config, paths));
  if (paths.platform === 'linux') {
    await execute('systemctl', ['--user', 'daemon-reload']);
    await execute('systemctl', ['--user', 'enable', paths.unit]);
  }
  return config;
}

export async function isLoaded(paths, execute = exec) {
  try {
    if (paths.platform === 'darwin') await execute('launchctl', ['print', `${domain()}/${paths.label}`]);
    else {
      const { stdout } = await execute('systemctl', ['--user', 'show', paths.unit, '--property=ActiveState', '--value']);
      return !['inactive', 'failed', ''].includes(stdout.trim());
    }
    return true;
  } catch (error) {
    // A failed lookup can also mean no user manager. Other commands report that explicitly.
    if (error.code === 'ENOENT') throw error;
    return false;
  }
}

export async function manage(action, paths = servicePaths(), execute = exec) {
  if (action === 'stop' || action === 'restart' || action === 'uninstall') {
    if (paths.platform === 'linux') await execute('systemctl', ['--user', 'stop', paths.unit]);
    else if (await isLoaded(paths, execute)) await execute('launchctl', ['bootout', `${domain()}/${paths.label}`]);
    // launchctl bootout may return before the job's graceful shutdown finishes.
    const config = await json(paths.config);
    const deadline = Date.now() + (config.stopTimeout + 7) * 1000;
    while (await exists(paths.status)) {
      const state = await json(paths.status).catch(() => null);
      if (!state || !alive(state.pid)) { await rm(paths.status, { force: true }); break; }
      if (Date.now() >= deadline) throw new Error('Service has not stopped; inspect its logs.');
      await delay(100);
    }
  }
  if (action === 'uninstall') {
    if (paths.platform === 'linux') await execute('systemctl', ['--user', 'disable', paths.unit]);
    await rm(paths.definition, { force: true });
    if (paths.platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload']);
    // Keep credentials/configuration/logs so uninstall never removes user data.
    return;
  }
  if (action === 'start' || action === 'restart') {
    const config = await json(paths.config);
    if (paths.platform === 'linux') {
      await execute('systemctl', ['--user', 'reset-failed', paths.unit]);
      await execute('systemctl', ['--user', 'start', paths.unit]);
    } else if (!(await isLoaded(paths, execute))) await execute('launchctl', ['bootstrap', domain(), paths.definition]);
    else await execute('launchctl', ['kickstart', `${domain()}/${paths.label}`]);
    const deadline = Date.now() + config.startupTimeout * 1000;
    while (Date.now() < deadline) {
      const state = await json(paths.status).catch(() => null);
      if (state && alive(state.pid) && state.state === 'ready') return state;
      if (state && alive(state.pid) && state.state === 'error') throw new Error('Pi HTTP startup failed; inspect service logs.');
      await delay(100);
    }
    throw new Error('Timed out waiting for Pi HTTP readiness; inspect service logs. The OS service manager may retry.');
  }
  if (action === 'status') {
    const state = await json(paths.status).catch(() => null);
    return { loaded: await isLoaded(paths, execute), runtime: state && alive(state.pid) ? state : null };
  }
}

export async function runService(configPath) {
  const config = await json(configPath);
  const environment = environmentMap(await json(config.environment));
  const release = await lockfile.lock(configPath, { stale: 10000, retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
  const token = randomUUID();
  const secrets = Object.entries(environment).filter(([key]) => /key|token|password|secret/i.test(key)).map(([, value]) => value).filter(Boolean);
  const log = message => {
    let value = String(message);
    for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
    process.stderr.write(`${new Date().toISOString()} [pi-agent-api-service] ${value}\n`);
  };
  // launchd reaps the job's process group on a wrapper crash. Keep Pi in that
  // group on macOS; systemd uses a cgroup, and direct runs get a separate group.
  const separateGroup = config.platform !== 'darwin';
  let child, stopping = false, failed = false, ready = false, killTimer, startupTimer, closed = false;
  const save = state => writePrivate(config.status, `${JSON.stringify({ pid: process.pid, child_pid: child?.pid, state, updated_at: new Date().toISOString() })}\n`);
  let saves = Promise.resolve();
  const status = state => { saves = saves.then(() => save(state)); return saves; };
  const kill = signal => {
    if (!child?.pid || closed) return;
    try { process.kill(separateGroup ? -child.pid : child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') log(error.message); }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    kill('SIGTERM');
    killTimer = setTimeout(() => { failed = true; log('Pi shutdown timed out; killing its process group.'); kill('SIGKILL'); }, config.stopTimeout * 1000);
  };
  const signal = () => { void status('stopping').catch(error => log(error.message)); stop(); };
  process.on('SIGTERM', signal);
  process.on('SIGINT', signal);
  process.on('SIGHUP', signal);
  const error = message => { failed = true; log(message); void status('error').catch(e => log(e.message)); stop(); };
  try {
    child = spawn(config.pi[0], [...config.pi.slice(1), '--mode', 'rpc', '-e', packageRoot, '--http', '--http-config', config.httpConfig], {
      cwd: config.cwd, env: { ...process.env, ...environment, PI_HTTP_SERVICE_READY_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'], detached: separateGroup,
    });
    const exit = new Promise(resolve => {
      child.once('error', e => { failed = true; log(`Could not start Pi: ${e.message}`); closed = true; resolve({ code: 1 }); });
      child.once('exit', (code, termination) => { closed = true; resolve({ code, termination }); });
    });
    // Keep stdin open for RPC mode. Never forward shell input or print raw RPC messages.
    child.stdin.on('error', () => {});
    await status('starting');
    const consume = (stream, onLine) => {
      // Bound pending output from extensions; a child cannot exhaust the launcher's memory.
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', text => {
        pending += text;
        if (pending.length > 1024 * 1024) { pending = ''; error('Pi output line exceeded 1 MiB.'); return; }
        let end;
        while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); onLine(line); }
      });
      stream.on('end', () => { if (pending) onLine(pending); });
    };
    const serviceEvent = event => {
      if (!event || typeof event !== 'object' || event.type !== 'pi_http_service' || event.token !== token) return false;
      if (stopping) return true;
      if (event.state === 'error') error('Pi HTTP extension failed to start.');
      if (event.state === 'ready' && !ready) {
        ready = true;
        clearTimeout(startupTimer);
        void status('ready').then(() => log('Pi HTTP is ready.')).catch(e => error(e.message));
      }
      return true;
    };
    consume(child.stderr, line => {
      // Pi protects RPC stdout by redirecting extension output to stderr.
      try { if (serviceEvent(JSON.parse(line))) return; } catch { /* Ordinary stderr. */ }
      log(line);
    });
    consume(child.stdout, line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (serviceEvent(event)) return;
      if (event?.type === 'extension_ui_request' && event.method === 'notify') log(event.message);
    });
    startupTimer = setTimeout(() => error('Pi HTTP startup timed out.'), config.startupTimeout * 1000);
    const result = await exit;
    if (!stopping) { failed = true; log(`Pi exited unexpectedly (${result.code ?? result.termination}).`); }
    return failed ? 1 : 0;
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(killTimer);
    // An exited Pi can leave descendants holding its output pipes open. Reap the
    // remaining process group and close our pipes instead of waiting for 'close'.
    if (child?.pid && (separateGroup || !closed)) { try { process.kill(separateGroup ? -child.pid : child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') log(e.message); } }
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
    process.off('SIGTERM', signal); process.off('SIGINT', signal); process.off('SIGHUP', signal);
    await saves.catch(e => log(e.message));
    await rm(config.status, { force: true });
    await release();
  }
}

function parse(argv) {
  const [action, ...rest] = argv;
  const names = { '--cwd': 'cwd', '--http-config': 'httpConfig', '--pi': 'pi', '--env-file': 'envFile',
    '--startup-timeout': 'startupTimeout', '--stop-timeout': 'stopTimeout', '--service-config': 'serviceConfig', '--data-dir': 'dataDir' };
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--legacy-service') {
      if (!['stop', 'status', 'logs', 'uninstall'].includes(action) || options.legacyService) throw new Error('--legacy-service is only accepted once by stop/status/logs/uninstall.');
      options.legacyService = true;
      continue;
    }
    const name = names[rest[index]];
    if (!name || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${rest[index]}`);
    const allowed = action === 'install' ? ['cwd', 'httpConfig', 'pi', 'envFile', 'startupTimeout', 'stopTimeout']
      : action === 'init' ? ['cwd', 'httpConfig', 'dataDir'] : action === 'run' ? ['serviceConfig'] : ['httpConfig'];
    if (!allowed.includes(name)) throw new Error('Options are only accepted by install/init; management accepts --http-config.');
    options[name] = rest[index + 1];
    index++;
  }
  return { action, options };
}
export async function main(argv) {
  const { action, options } = parse(argv);
  if (!action || ['--help', '-h', 'help'].includes(action)) {
    console.log(`Usage: pi-agent-api-service <init|install|start|stop|restart|status|logs|uninstall>\n\ninit options:\n  --data-dir PATH        Data root (default: /data/pi-agent-api)\n  --http-config PATH     Configuration to create; existing files are preserved\n\ninstall options:\n  --cwd PATH             Pi working directory (default: current directory)\n  --http-config PATH     HTTP configuration JSON (default: /data/pi-agent-api/config/pi-agent-api.config.json; legacy CWD file supported)\n  --pi PATH              Pi executable or CLI JavaScript file (default: pi on PATH)\n  --env-file PATH        JSON object of environment variables; copied to protected storage\n  --startup-timeout SEC  HTTP startup deadline (default: 60)\n  --stop-timeout SEC     Graceful stop deadline (default: max(45, HTTP grace + 10))\n\nmanagement options:\n  --legacy-service      Target the old pi-http job (stop/status/logs/uninstall only)\n\nLinux: per-user systemd service. macOS: per-user launchd LaunchAgent.\ninstall enables login startup but does not start the service immediately.\nSee README for API Key, credentials, logs, logout behavior and updates.`);
    return 0;
  }
  if (action === 'run') {
    if (!options.serviceConfig) throw new Error('run is an internal command requiring --service-config.');
    return runService(resolve(options.serviceConfig));
  }
  if (action === 'init') {
    const result = await initialize({ dataDir: options.dataDir, path: options.httpConfig, cwd: options.cwd });
    console.log(JSON.stringify(result, null, 2));
    console.log('Edit the HTTP configuration and private environment file, then install/start. Existing files were preserved.');
    return 0;
  }
  let loaded;
  if (options.legacyService && !options.httpConfig) {
    const cwdConfig = resolve(options.cwd ?? process.cwd(), 'pi-http.config.json');
    const configPath = await exists(cwdConfig) ? cwdConfig : join(LEGACY_DATA_DIR, 'config/pi-http.config.json');
    loaded = await exists(configPath) ? await readConfiguration({ path: configPath }) : { raw: {}, configPath };
  } else loaded = await readConfiguration({ path: options.httpConfig, cwd: options.cwd });
  const directories = resolveDirectories(loaded.raw, loaded.configPath);
  const legacyDefaults = options.legacyService && !options.httpConfig && !(await exists(loaded.configPath));
  let paths = servicePaths(process.platform, homedir(), legacyDefaults ? {} : directories, options.legacyService);
  // Existing installations remain manageable without moving or replacing their data.
  if (legacyDefaults) {
    const oldRoot = process.platform === 'linux' ? join(homedir(), '.config/pi-http') : join(homedir(), 'Library/Application Support/pi-http');
    if (await exists(join(oldRoot, 'service.json'))) paths = { ...paths, root: oldRoot,
      config: join(oldRoot, 'service.json'), environment: join(oldRoot, 'environment.json'),
      status: join(oldRoot, 'status.json'), log: join(oldRoot, 'service.log') };
  }
  if (action === 'install') {
    await install(options, paths);
    console.log(`Installed ${paths.definition}\nCredentials: ${paths.environment} (0600)\nRun pi-agent-api-service start to start Pi.`);
    return 0;
  }
  if (action === 'logs') {
    const child = paths.platform === 'linux'
      ? spawn('tail', ['-n', '100', '-F', join(legacyDefaults ? dirname(paths.log) : directories.logDir, 'http.jsonl')], { stdio: 'inherit' })
      : spawn('tail', ['-n', '100', '-F', join(legacyDefaults ? dirname(paths.log) : directories.logDir, 'http.jsonl'), paths.log], { stdio: 'inherit' });
    return new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1)); });
  }
  if (!['start', 'stop', 'restart', 'status', 'uninstall'].includes(action)) throw new Error(`Unknown command: ${action}`);
  const result = await manage(action, paths);
  console.log(result ? JSON.stringify(result, null, 2) : `${action} completed.`);
  return action === 'status' && (!result.loaded || result.runtime?.state !== 'ready') ? 1 : 0;
}
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === script) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`pi-agent-api-service: ${error.message}`); process.exitCode = 1; });
}
