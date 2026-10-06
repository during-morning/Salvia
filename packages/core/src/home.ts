import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Salvia keeps its database, caches and browser profile (`SALVIA_HOME` overrides). */
export function salviaHome(): string {
  return process.env.SALVIA_HOME ?? join(homedir(), '.salvia');
}

export function cacheDir(...parts: string[]): string {
  const dir = join(salviaHome(), 'cache', ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
