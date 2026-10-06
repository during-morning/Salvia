import { FatalError, getJson } from '@salvia/core';
import type { MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { PC_UA, sha1 } from '@salvia/music';

/**
 * Jamendo: independent music under Creative Commons licences, free to download. Uses the site's
 * own JSON API (each call carries the `x-jam-call` token its scripts compute: sha1 of path + a
 * random number). Search, tracks, albums, playlists.
 */

const HEADERS = { 'user-agent': PC_UA, referer: 'https://www.jamendo.com/search?q=salvia' };

export function jamCall(path: string, random = String(Math.random())): string {
  return `$${sha1(path + random)}*${random}~`;
}

function api<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  return getJson<T>(`https://www.jamendo.com${path}?${new URLSearchParams(params)}`, {
    headers: { ...HEADERS, 'x-jam-call': jamCall(path), 'x-jam-version': '4gvfvv', 'x-requested-with': 'XMLHttpRequest' },
    signal,
  });
}

interface Item {
  id: number;
  name: string;
  duration?: number;
  albumId?: number;
  artist?: { name?: string };
  album?: { name?: string };
  cover?: { big?: { size300?: string } };
  download?: Record<string, string>;
  stream?: Record<string, string>;
}

/** Stream keys, best first: flac, mp3 320 (mp33), mp3 (mp32 / mp3), ogg. */
const LEVELS: { key: string; label: string; ext: Quality['ext']; kbps: number }[] = [
  { key: 'flac', label: '无损 FLAC', ext: 'flac', kbps: 1000 },
  { key: 'mp33', label: '320k MP3', ext: 'mp3', kbps: 320 },
  { key: 'mp32', label: 'MP3 VBR', ext: 'mp3', kbps: 192 },
  // The download file (Jamendo's own "free download"): mp3 at the artist's upload quality.
  { key: 'mp3', label: 'MP3', ext: 'mp3', kbps: 0 },
  { key: 'mp31', label: '96k MP3', ext: 'mp3', kbps: 96 },
  { key: 'ogg', label: 'OGG', ext: 'ogg', kbps: 160 },
];

function toTrack(i: Item, album?: string): Track {
  const streams = { ...(i.stream ?? {}), ...(i.download ?? {}) };
  return {
    id: String(i.id),
    source: 'jamendo',
    title: i.name,
    artists: [i.artist?.name ?? ''].filter(Boolean),
    album: i.album?.name ?? album,
    duration: i.duration,
    cover: i.cover?.big?.size300,
    extra: { streams: JSON.stringify(streams), albumId: i.albumId ?? '' },
  };
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const r = await api<Item[]>('/api/search', { query, type: 'track', limit: '20', identities: 'www' }, signal);
  return r.map((i) => toTrack(i));
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  let streams = t.extra?.streams ? (JSON.parse(String(t.extra.streams)) as Record<string, string>) : {};
  if (!Object.keys(streams).length) {
    const [item] = await api<Item[]>('/api/tracks', { id: t.id }, signal);
    streams = { ...(item?.stream ?? {}), ...(item?.download ?? {}) };
  }
  return LEVELS.filter((l) => streams[l.key]).map((l) => ({ id: l.key, label: l.label, ext: l.ext, kbps: l.kbps || undefined, url: streams[l.key]! }));
}

async function tracksById(ids: number[], album: string | undefined, signal?: AbortSignal): Promise<Track[]> {
  const out: Track[] = [];
  // Four at a time, as the site's own pages do.
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await Promise.all(ids.slice(i, i + 4).map((id) => api<Item[]>('/api/tracks', { id: String(id) }, signal).then((r) => r[0]).catch(() => undefined)));
    for (const item of batch) if (item) out.push(toTrack(item, album));
  }
  return out;
}

async function album(id: string, signal?: AbortSignal): Promise<TrackList> {
  const [a] = await api<{ id: number; name: string; tracks?: { id: number }[] }[]>('/api/albums', { id }, signal);
  if (!a) throw new FatalError('专辑不存在。');
  const tracks = await tracksById((a.tracks ?? []).map((x) => x.id), a.name, signal);
  return { title: a.name, kind: 'album', tracks };
}

async function playlist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const [p] = await api<{ id: number; name: string; tracks?: { id: number }[] }[]>('/api/playlists', { id }, signal);
  if (!p) throw new FatalError('歌单不存在。');
  const tracks = await tracksById((p.tracks ?? []).map((x) => x.id), undefined, signal);
  return { title: p.name, kind: 'playlist', tracks };
}

export const jamendo: MusicProvider = {
  source: 'jamendo',
  name: 'Jamendo',
  headers: HEADERS,
  async list(url, signal) {
    const track = url.match(/\/track\/(\d+)/)?.[1];
    if (track) {
      const tracks = await tracksById([Number(track)], undefined, signal);
      if (!tracks.length) throw new FatalError('歌曲不存在。');
      return { title: tracks[0]!.title, kind: 'track', tracks };
    }
    const albumId = url.match(/\/album\/(\d+)/)?.[1];
    if (albumId) return album(albumId, signal);
    const list = url.match(/\/playlist\/(\d+)/)?.[1];
    if (list) return playlist(list, signal);
    throw new FatalError('没有识别出 Jamendo 的歌曲、专辑或歌单编号。');
  },
  search,
  qualities,
};
