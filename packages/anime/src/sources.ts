import { provided, slot, type Column, type Context, type ListOptions, type PickItem } from '@salvia/core';
import type { Subject } from './bangumi.ts';

/** A title in a source's own catalogue (B站 番剧 …). */
export interface CatalogEntry {
  /** The AnimeSource it belongs to. */
  source: string;
  id: string;
  title: string;
  original?: string;
  episodes?: number;
  score?: number;
  year?: string;
  type?: string;
}

/** A title as the user picked it: its names, Bangumi's details, and the catalogue entries that match. */
export interface AnimeTitle {
  names: string[];
  subject?: Subject;
  entries: CatalogEntry[];
}

/** What a source offers for a title: rows to list (its own picks), optionally as a table with a batch action. */
export interface AnimeOffers {
  items: PickItem[];
  columns?: Column[];
  batch?: ListOptions['batch'];
  /** For the status line ("622 个 BT 资源"). */
  summary?: string;
  /** Said alongside (how BT shares while downloading …). */
  note?: string;
}

/**
 * Where anime can be downloaded from. Platform modules provide these: official catalogues with
 * their own titles (B站 番剧), and searchable indexes (BT).
 */
export interface AnimeSource {
  /** `@anime:<id>`. */
  id: string;
  name: string;
  aliases?: string[];
  /** Licensed (listed first, and counted as "正版"). */
  official?: boolean;
  /** Its own titles for a keyword, matched to Bangumi's (the 片源 column; titles Bangumi lacks). */
  catalog?(keyword: string, signal?: AbortSignal): Promise<CatalogEntry[]>;
  offers(title: AnimeTitle, ctx: Context): Promise<AnimeOffers | undefined>;
}

export const ANIME_SOURCES = slot<AnimeSource>('anime.source');

export const animeSources = (): AnimeSource[] => provided(ANIME_SOURCES);

export function animeSource(name: string): AnimeSource | undefined {
  const n = name.toLowerCase();
  return animeSources().find((s) => s.id === n || s.aliases?.some((a) => a.toLowerCase() === n));
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[\s·・:：!！?？,，.。'"“”‘’()（）[\]【】~～\-_/]/g, '');

/** Catalogue entries of a Bangumi title: same Chinese or original name. */
export function matchCatalog(s: Pick<Subject, 'name' | 'name_cn'>, entries: CatalogEntry[]): CatalogEntry[] {
  const names = [s.name_cn, s.name].map(norm).filter(Boolean);
  return entries.filter((e) => names.includes(norm(e.title)) || (e.original && names.includes(norm(e.original))));
}
