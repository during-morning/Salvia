import { getJson } from '@salvia/core';

/** Bangumi (bgm.tv, as Animeko uses): anime titles, ratings, staff and summaries. */

const BGM_HEADERS = { 'user-agent': 'salvia/0.1 (https://github.com/salvia)', 'content-type': 'application/json' };

export interface Subject {
  id: number;
  name: string;
  name_cn?: string;
  date?: string;
  /** episodes */
  eps?: number;
  total_episodes?: number;
  rating?: { score?: number; total?: number; rank?: number };
  summary?: string;
  tags?: { name: string; count?: number }[];
  images?: { common?: string; large?: string };
  infobox?: { key: string; value: unknown }[];
  platform?: string;
}

/**
 * Anime subjects for a keyword. The v0 search answers HTTP 500 now and then; the older search
 * endpoint (fewer fields: no rating) stands in for it then.
 */
export async function bangumiSearch(keyword: string, signal?: AbortSignal): Promise<Subject[]> {
  try {
    const r = await getJson<{ data?: Subject[] }>('https://api.bgm.tv/v0/search/subjects?limit=20', {
      method: 'POST',
      headers: BGM_HEADERS,
      body: JSON.stringify({ keyword, sort: 'match', filter: { type: [2], nsfw: false } }),
      signal,
      timeout: 10_000,
      retries: 1,
    });
    return r.data ?? [];
  } catch (err) {
    if (signal?.aborted) throw err;
    return legacySearch(keyword, signal);
  }
}

async function legacySearch(keyword: string, signal?: AbortSignal): Promise<Subject[]> {
  type L = { id: number; name: string; name_cn?: string; air_date?: string; eps?: number; eps_count?: number; images?: Subject['images'] };
  const r = await getJson<{ list?: L[] }>(`https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=medium&max_results=20`, {
    headers: BGM_HEADERS,
    signal,
    timeout: 10_000,
  });
  return (r.list ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    name_cn: s.name_cn || undefined,
    date: s.air_date || undefined,
    eps: s.eps_count || s.eps || undefined,
    images: s.images,
  }));
}

export async function bangumiSubject(id: number, signal?: AbortSignal): Promise<Subject> {
  return getJson<Subject>(`https://api.bgm.tv/v0/subjects/${id}`, { headers: BGM_HEADERS, signal, timeout: 10_000, retries: 1 });
}

/** Bangumi's infobox values are strings or lists of {v}. */
export function infoValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x && 'v' in x ? String((x as { v: unknown }).v) : String(x))).join('、');
  return '';
}
