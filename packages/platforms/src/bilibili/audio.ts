import { FatalError, getJson, getText } from '@salvia/core';
import type { Lyrics, Quality, Track, TrackList } from '@salvia/music';
import { BILI_HEADERS } from './client.ts';

/**
 * B站音频区: songs (au号) and their playlists (am号), from bilibili.com/audio. The audio is
 * served as a file per song; quality is what the account may play (lossless for 大会员).
 */

const API = 'https://www.bilibili.com/audio/music-service-c/web';

interface SongInfo {
  id: number;
  title: string;
  uname?: string;
  author?: string;
  cover?: string;
  duration?: number;
  lyric?: string;
  intro?: string;
}

interface Answer<T> {
  code: number;
  msg?: string;
  data: T | null;
}

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await getJson<Answer<T>>(`${API}/${path}`, { headers: BILI_HEADERS, signal });
  if (r.code !== 0 || !r.data) throw new FatalError(r.msg || `B站音频返回错误 ${r.code}`);
  return r.data;
}

/** au12345 / am12345 in a link or typed alone. */
export function parseAudio(input: string): { kind: 'song' | 'menu'; id: string } | undefined {
  const au = input.match(/\bau(\d+)/i)?.[1] ?? input.match(/audio\/[^?#]*[?&]sid=(\d+)/)?.[1];
  if (au) return { kind: 'song', id: au };
  const am = input.match(/\bam(\d+)/i)?.[1];
  if (am) return { kind: 'menu', id: am };
  return undefined;
}

function toTrack(s: SongInfo): Track {
  return {
    id: `au${s.id}`,
    source: 'bilibili',
    title: s.title,
    artists: [s.author || s.uname || ''].filter(Boolean),
    duration: s.duration || undefined,
    cover: s.cover,
    extra: { au: s.id, ...(s.lyric ? { lyric: s.lyric } : {}) },
  };
}

export async function audioList(input: string, signal?: AbortSignal): Promise<TrackList> {
  const ref = parseAudio(input);
  if (!ref) throw new FatalError('没有识别出 B站音频编号（au / am）。');
  if (ref.kind === 'song') {
    const t = toTrack(await api<SongInfo>(`song/info?sid=${ref.id}`, signal));
    return { title: t.title, kind: 'track', tracks: [t] };
  }
  const tracks: Track[] = [];
  let title = `B站歌单 am${ref.id}`;
  for (let pn = 1; pn <= 10; pn++) {
    const page = await api<{ data?: SongInfo[]; pageCount?: number }>(`song/of-menu?sid=${ref.id}&pn=${pn}&ps=100`, signal);
    tracks.push(...(page.data ?? []).map(toTrack));
    if (!page.pageCount || pn >= page.pageCount) break;
  }
  const info = await api<{ title?: string }>(`menu/info?sid=${ref.id}`, signal).catch(() => undefined);
  if (info?.title) title = info.title;
  return { title, kind: 'playlist', tracks };
}

const LEVELS: Record<number, { label: string; ext: Quality['ext'] }> = {
  0: { label: '128k AAC', ext: 'm4a' },
  1: { label: '192k AAC', ext: 'm4a' },
  2: { label: '320k AAC', ext: 'm4a' },
  3: { label: '无损 FLAC', ext: 'flac' },
};

/** The best file the account may play (asking for lossless; the site answers with what it allows). */
export async function audioQualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  const sid = String(t.extra?.au ?? t.id.replace(/^au/, ''));
  const r = await api<{ type: number; size?: number; cdns?: string[] }>(`url?sid=${sid}&privilege=2&quality=3`, signal);
  const [url, ...mirrors] = r.cdns ?? [];
  if (!url) return [];
  const level = LEVELS[r.type] ?? LEVELS[1]!;
  return [{ id: `au${r.type}`, label: level.label, ext: level.ext, size: r.size || undefined, url, mirrors }];
}

export async function audioLyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const url = t.extra?.lyric ? String(t.extra.lyric) : undefined;
  if (!url) return undefined;
  const lrc = (await getText(url, { headers: BILI_HEADERS, signal }).catch(() => '')).trim();
  return lrc ? { lrc } : undefined;
}

export const isAudioTrack = (t: Track) => t.extra?.au !== undefined || /^au\d+$/.test(t.id);
