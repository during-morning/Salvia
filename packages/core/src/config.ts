import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, cookieStore, kv } from './db.ts';
import { salviaHome } from './home.ts';

export { salviaHome, cacheDir } from './home.ts';

export interface Config {
  downloadDir: string;
  concurrency: number;
  /** Cookies keyed by site id: bili, netease, qq, ... */
  cookies: Record<string, string>;
  /** Free-form per-module settings (spotify credentials, qq qimei, ...). */
  extra: Record<string, unknown>;
}

function defaults(): Config {
  return {
    downloadDir: join(homedir(), 'Downloads', 'Salvia'),
    concurrency: 3,
    cookies: {},
    extra: {},
  };
}

let current: Config | undefined;

/** The config.json older versions wrote; read once into the database. */
function legacyFile(): Partial<Config> | undefined {
  try {
    return JSON.parse(readFileSync(join(salviaHome(), 'config.json'), 'utf8')) as Partial<Config>;
  } catch {
    return undefined;
  }
}

function migrate(): void {
  if (kv.get('schema')) return;
  const old = legacyFile();
  if (old) {
    if (old.downloadDir) kv.set('downloadDir', old.downloadDir);
    if (old.concurrency) kv.set('concurrency', old.concurrency);
    if (old.extra) kv.set('extra', old.extra);
    if (old.cookies) cookieStore.replace(old.cookies);
  }
  kv.set('schema', 1);
}

export function loadConfig(): Config {
  if (current) return current;
  const d = defaults();
  try {
    migrate();
    current = {
      downloadDir: kv.get<string>('downloadDir') ?? d.downloadDir,
      concurrency: kv.get<number>('concurrency') ?? d.concurrency,
      cookies: cookieStore.all(),
      extra: kv.get<Record<string, unknown>>('extra') ?? {},
    };
  } catch {
    // No usable database (read-only home …): the old file, else defaults, for this run.
    current = { ...d, ...legacyFile() };
  }
  return current;
}

export function saveConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  if (patch.cookies) cookieStore.replace(patch.cookies);
  if (patch.downloadDir !== undefined) kv.set('downloadDir', patch.downloadDir);
  if (patch.concurrency !== undefined) kv.set('concurrency', patch.concurrency);
  if (patch.extra) kv.set('extra', patch.extra);
  current = next;
  return next;
}

/** For tests. */
export function resetConfigCache(): void {
  current = undefined;
  closeDatabase();
}
