import { access, mkdir, readFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_DATA_DIR = '/data/pi-http';
export const DEFAULT_CONFIG_PATH = join(DEFAULT_DATA_DIR, 'config/pi-http.config.json');
const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export async function readConfiguration({ path, cwd = process.cwd() } = {}) {
  const legacy = resolve(cwd, 'pi-http.config.json');
  const configPath = path ? resolve(cwd, path) : await exists(legacy) ? legacy : DEFAULT_CONFIG_PATH;
  let raw;
  try {
    const text = await readFile(configPath, 'utf8');
    try { raw = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${configPath}.`); }
  }
  catch (e) { if (e.code !== 'ENOENT' || path) throw e; raw = {}; }
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('config must be an object.');
  return { raw, configPath };
}
export function resolveDirectories(raw, configPath) {
  const base = dirname(configPath);
  const section = raw.paths === undefined ? {} : raw.paths;
  if (!section || Array.isArray(section) || typeof section !== 'object') throw new Error('paths must be an object.');
  for (const key of Object.keys(section)) if (!['data_dir', 'config_dir'].includes(key)) throw new Error(`Unknown configuration field: paths.${key}`);
  const path = (value, fallback, label) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
    return resolve(base, value);
  };
  const dataDir = path(section.data_dir, DEFAULT_DATA_DIR, 'paths.data_dir');
  return { dataDir, configDir: path(section.config_dir, join(dataDir, 'config'), 'paths.config_dir'),
    logDir: path(raw.logging?.directory, join(dataDir, 'logs'), 'logging.directory') };
}
export async function ensureDirectory(path) {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch (e) { throw new Error(`Cannot create directory ${path} (${e.code ?? 'unknown error'}). Configure a writable path.`, { cause: e }); }
}
async function createPrivate(path, data) {
  await ensureDirectory(dirname(path));
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { await file.writeFile(data); } finally { await file.close(); }
  return true;
}
export async function initialize({ dataDir, path, cwd = process.cwd() } = {}) {
  if (!path && dataDir === undefined) {
    const selected = await readConfiguration({ cwd });
    if (await exists(selected.configPath)) path = selected.configPath;
  }
  dataDir = resolve(cwd, dataDir ?? DEFAULT_DATA_DIR);
  const configPath = path ? resolve(cwd, path) : join(dataDir, 'config/pi-http.config.json');
  await createPrivate(configPath, `${JSON.stringify({ paths: { data_dir: dataDir },
    server: { host: '127.0.0.1', port: 3000, shutdown_grace_seconds: 30 },
    chat: { ttl_seconds: 86400, cleanup_interval_seconds: 300 },
    upload: { max_file_bytes: 0, max_request_bytes: 0, max_files: 0 },
    logging: { enabled: true, log_bodies: true, max_body_chars: 16384, max_file_bytes: 10485760, max_files: 7 },
  }, null, 2)}\n`);
  const { raw } = await readConfiguration({ path: configPath });
  const directories = resolveDirectories(raw, configPath);
  for (const directory of Object.values(directories)) await ensureDirectory(directory);
  const base = dirname(configPath);
  await ensureDirectory(raw.chat?.storage_dir ? resolve(base, raw.chat.storage_dir) : join(directories.dataDir, 'chats'));
  await ensureDirectory(dirname(raw.storage?.database_path ? resolve(base, raw.storage.database_path) : join(directories.dataDir, 'pi-http.sqlite')));
  const environmentPath = join(directories.configDir, 'environment.json');
  await createPrivate(environmentPath, `${JSON.stringify({ PI_HTTP_API_KEY: process.env.PI_HTTP_API_KEY?.trim() ? process.env.PI_HTTP_API_KEY : randomBytes(32).toString('hex') }, null, 2)}\n`);
  return { configPath, environmentPath, ...directories };
}
