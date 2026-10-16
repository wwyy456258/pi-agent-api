export const DEFAULT_DATA_DIR: string;
export const DEFAULT_CONFIG_PATH: string;
export function readConfiguration(options?: {path?: string; cwd?: string}): Promise<{raw: Record<string, unknown>; configPath: string}>;
export function resolveDirectories(raw: Record<string, unknown>, configPath: string): {dataDir: string; configDir: string; logDir: string};
export function ensureDirectory(path: string): Promise<void>;
export function initialize(options?: {dataDir?: string; path?: string; cwd?: string}): Promise<{configPath: string; environmentPath: string; dataDir: string; configDir: string; logDir: string}>;
