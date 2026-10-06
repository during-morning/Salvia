import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { salviaHome } from './home.ts';

/**
 * ~/.salvia/salvia.db (Node's built-in SQLite): settings, login cookies and the download history.
 * One connection per home directory; WAL so a second Salvia process can read while one writes.
 */
let db: DatabaseSync | undefined;
let dbHome: string | undefined;

export function database(): DatabaseSync {
  const home = salviaHome();
  if (db && dbHome === home) return db;
  db?.close();
  mkdirSync(home, { recursive: true });
  db = new DatabaseSync(join(home, 'salvia.db'));
  dbHome = home;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cookies (site TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT,
      error TEXT,
      finished INTEGER NOT NULL
    );
  `);
  return db;
}

/** For tests: drop the connection so the next call opens the current home's database. */
export function closeDatabase(): void {
  db?.close();
  db = undefined;
  dbHome = undefined;
}

/** JSON values by key. */
export const kv = {
  get<T>(key: string): T | undefined {
    const row = database().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: unknown): void {
    if (value === undefined) return kv.delete(key);
    database().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  },
  delete(key: string): void {
    database().prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
};

/** Login cookies by site key (bili, netease, qq, spotify …), as @login / @cookie save them. */
export const cookieStore = {
  all(): Record<string, string> {
    const rows = database().prepare('SELECT site, value FROM cookies').all() as { site: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.site, r.value]));
  },
  /** Make the table exactly `cookies`. */
  replace(cookies: Record<string, string>): void {
    const d = database();
    const now = Date.now();
    d.exec('BEGIN');
    try {
      const keep = Object.keys(cookies);
      for (const site of Object.keys(cookieStore.all())) if (!keep.includes(site)) d.prepare('DELETE FROM cookies WHERE site = ?').run(site);
      const up = d.prepare('INSERT INTO cookies (site, value, updated) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE value <> excluded.value');
      for (const [site, value] of Object.entries(cookies)) up.run(site, value, now);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  },
};

/** A finished download, for the task area's history. */
export interface DownloadRecord {
  id: string;
  title: string;
  kind: string;
  status: 'done' | 'error' | 'canceled';
  path?: string;
  error?: string;
  /** ms epoch */
  finished: number;
}

export const downloadStore = {
  add(r: DownloadRecord): void {
    database()
      .prepare('INSERT OR REPLACE INTO downloads (id, title, kind, status, path, error, finished) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.title, r.kind, r.status, r.path ?? null, r.error ?? null, r.finished);
  },
  list(limit = 50): DownloadRecord[] {
    const rows = database().prepare('SELECT * FROM downloads ORDER BY finished DESC LIMIT ?').all(limit) as unknown as (Omit<DownloadRecord, 'path' | 'error'> & { path: string | null; error: string | null })[];
    return rows.map((r) => ({ ...r, path: r.path ?? undefined, error: r.error ?? undefined }));
  },
  remove(id: string): void {
    database().prepare('DELETE FROM downloads WHERE id = ?').run(id);
  },
};
