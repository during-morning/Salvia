import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackaged, packagedAsset, packagedKeys, salviaHome } from '@salvia/core';
import { parseLooseJson } from './rule/js.ts';

/** Legado book source (the fields Salvia uses; unknown fields are kept when re-saved). */
export interface BookSource {
  bookSourceUrl: string;
  bookSourceName: string;
  bookSourceGroup?: string;
  bookSourceType?: number;
  enabled?: boolean;
  /** JSON object as a string (or object), extra request headers. */
  header?: string | Record<string, string>;
  bookUrlPattern?: string;
  searchUrl?: string;
  ruleSearch?: {
    checkKeyWord?: string;
    bookList?: string;
    name?: string;
    author?: string;
    kind?: string;
    wordCount?: string;
    lastChapter?: string;
    intro?: string;
    coverUrl?: string;
    bookUrl?: string;
  };
  ruleBookInfo?: {
    init?: string;
    name?: string;
    author?: string;
    kind?: string;
    wordCount?: string;
    lastChapter?: string;
    intro?: string;
    coverUrl?: string;
    tocUrl?: string;
  };
  ruleToc?: {
    chapterList?: string;
    chapterName?: string;
    chapterUrl?: string;
    isVolume?: string;
    isVip?: string;
    nextTocUrl?: string;
  };
  ruleContent?: {
    content?: string;
    nextContentUrl?: string;
    replaceRegex?: string;
    title?: string;
  };
  [key: string]: unknown;
}

function userFile(): string {
  return join(salviaHome(), 'sources', 'imported.json');
}

/** Accept a single source, an array, or the wrappers some exporters produce. */
export function parseSources(text: string): BookSource[] {
  const data = JSON.parse(text.replace(/^﻿/, '')) as unknown;
  const list = Array.isArray(data) ? data : [data];
  return list.filter(
    (s): s is BookSource =>
      !!s && typeof s === 'object' && typeof (s as BookSource).bookSourceUrl === 'string' && typeof (s as BookSource).bookSourceName === 'string',
  );
}

function readList(file: string): BookSource[] {
  try {
    return parseSources(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Repo `sources/` (source checkout) or `sources/` next to the bundled app.mjs. The single-file
 * build embeds them as "sources/*.json" assets instead.
 */
function builtinDir(): string | undefined {
  for (const rel of ['../../../sources', './sources']) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(dir)) return dir;
    } catch {
      // not a file URL
    }
  }
  return undefined;
}

export function builtinSources(): BookSource[] {
  if (isPackaged()) {
    return packagedKeys('sources/').flatMap((k) => {
      try {
        return parseSources(packagedAsset(k)!.toString('utf8'));
      } catch {
        return [];
      }
    });
  }
  const dir = builtinDir();
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => readList(join(dir, f)));
  } catch {
    return [];
  }
}

export function importedSources(): BookSource[] {
  return readList(userFile());
}

/** Text sources the user has enabled: imported ones override built-ins with the same URL. */
export function allSources(): BookSource[] {
  const map = new Map<string, BookSource>();
  for (const s of [...builtinSources(), ...importedSources()]) map.set(s.bookSourceUrl, s);
  return [...map.values()].filter((s) => s.enabled !== false && (s.bookSourceType ?? 0) === 0 && s.searchUrl);
}

/** Merge new sources into the user's list (same bookSourceUrl replaces). Returns how many were added/updated. */
export function saveImported(sources: BookSource[]): number {
  const map = new Map(importedSources().map((s) => [s.bookSourceUrl, s]));
  for (const s of sources) map.set(s.bookSourceUrl, s);
  const file = userFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...map.values()], null, 2));
  return sources.length;
}

export function removeImported(match: (s: BookSource) => boolean): number {
  const all = importedSources();
  const keep = all.filter((s) => !match(s));
  const file = userFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keep, null, 2));
  return all.length - keep.length;
}

/** A link imported with `@source add`, read again by `@source update`. */
export interface Subscription {
  url: string;
  /** bookSourceUrl of each source it gave last time. */
  sources: string[];
  updated: number;
}

function subscriptionFile(): string {
  return join(salviaHome(), 'sources', 'subscriptions.json');
}

export function subscriptions(): Subscription[] {
  try {
    const list = JSON.parse(readFileSync(subscriptionFile(), 'utf8')) as unknown;
    return Array.isArray(list) ? (list as Subscription[]).filter((s) => typeof s?.url === 'string' && Array.isArray(s.sources)) : [];
  } catch {
    return [];
  }
}

function saveSubscriptions(list: Subscription[]): void {
  const file = subscriptionFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 2));
}

/** What other subscriptions still list (kept when one subscription drops a source). */
const listedElsewhere = (subs: Subscription[], url: string) => new Set(subs.filter((s) => s.url !== url).flatMap((s) => s.sources));

/**
 * Take a subscription's current list: its sources are imported, and the ones it gave before but no
 * longer lists are removed. Returns how many it has and how many were removed.
 */
export function applySubscription(url: string, sources: BookSource[]): { count: number; removed: number } {
  const subs = subscriptions();
  const now = new Set(sources.map((s) => s.bookSourceUrl));
  const elsewhere = listedElsewhere(subs, url);
  const gone = new Set((subs.find((s) => s.url === url)?.sources ?? []).filter((u) => !now.has(u) && !elsewhere.has(u)));
  const removed = gone.size ? removeImported((s) => gone.has(s.bookSourceUrl)) : 0;
  saveImported(sources);
  saveSubscriptions([...subs.filter((s) => s.url !== url), { url, sources: [...now], updated: Date.now() }]);
  return { count: now.size, removed };
}

/** Drop a subscription and the sources only it gave. Undefined when there is no such subscription. */
export function removeSubscription(url: string): number | undefined {
  const subs = subscriptions();
  const sub = subs.find((s) => s.url === url);
  if (!sub) return undefined;
  const elsewhere = listedElsewhere(subs, url);
  const drop = new Set(sub.sources.filter((u) => !elsewhere.has(u)));
  const removed = removeImported((s) => drop.has(s.bookSourceUrl));
  saveSubscriptions(subs.filter((s) => s.url !== url));
  return removed;
}

/**
 * The source's `header` field: a JSON object (usual), a bare User-Agent string (old sources), or
 * `@js:` / `<js>` code that returns the JSON (evaluated by the caller-supplied runner).
 */
export function sourceHeaders(s: BookSource, runJs?: (code: string) => unknown): Record<string, string> {
  if (!s.header) return {};
  if (typeof s.header === 'object') return s.header;
  let text = s.header.trim();
  const js = text.match(/^@js:([\s\S]*)$/i)?.[1] ?? text.match(/^<js>([\s\S]*)<\/js>$/i)?.[1];
  if (js !== undefined) {
    try {
      const out = runJs?.(js);
      if (out && typeof out === 'object') return out as Record<string, string>;
      text = String(out ?? '');
    } catch {
      return {};
    }
  }
  try {
    // Loose: sources write single-quoted keys and values too.
    const parsed = parseLooseJson(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    // A bare, single-line User-Agent (old sources); anything else is unusable.
    return !/[\r\n{}]/.test(text) && /^Mozilla\//i.test(text) ? { 'User-Agent': text } : {};
  }
}
