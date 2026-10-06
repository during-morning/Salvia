import { FatalError, getJson, getText } from '@salvia/core';
import type { MusicProvider, Track, TrackList } from '@salvia/music';
import { PC_UA } from '@salvia/music';

/**
 * Apple Music catalog (as in guohuiyuan/music-lib, reimplemented): search, songs, albums and
 * playlists through the API the web player uses, with the developer token that ships in its
 * script. Full tracks are DRM-protected; the public 30-second previews serve as 试听, and the
 * audio for downloads is matched like Spotify's.
 */

let token: { value: string; at: number } | undefined;

async function developerToken(signal?: AbortSignal): Promise<string> {
  if (token && Date.now() - token.at < 12 * 3600_000) return token.value;
  const home = await getText('https://music.apple.com/us/new', { headers: { 'user-agent': PC_UA }, signal });
  const script = home.match(/\/(assets\/index(?:-legacy)?[~-][^/"]+\.js)/)?.[1];
  if (!script) throw new FatalError('读取 Apple Music 网页播放器失败。');
  const js = await getText(`https://music.apple.com/${script}`, { headers: { 'user-agent': PC_UA }, signal, timeout: 60_000 });
  const value = js.match(/["'](eyJ[\w-]+\.[\w-]+\.[\w-]+)["']/)?.[1];
  if (!value) throw new FatalError('没有在 Apple Music 网页播放器里找到访问令牌。');
  token = { value, at: Date.now() };
  return value;
}

async function amp<T>(path: string, signal?: AbortSignal): Promise<T> {
  return getJson<T>(`https://amp-api.music.apple.com${path}`, {
    headers: { authorization: `Bearer ${await developerToken(signal)}`, origin: 'https://music.apple.com', 'user-agent': PC_UA },
    signal,
  });
}

interface Song {
  id: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    artwork?: { url?: string };
    previews?: { url?: string }[];
    releaseDate?: string;
  };
}

function toTrack(s: Song): Track | undefined {
  const a = s.attributes;
  if (!a?.name || (s.type && s.type !== 'songs')) return undefined;
  return {
    id: s.id,
    source: 'apple',
    title: a.name,
    artists: (a.artistName ?? '').split(/\s*(?:&|,)\s*/).filter(Boolean),
    album: a.albumName,
    duration: a.durationInMillis ? Math.round(a.durationInMillis / 1000) : undefined,
    cover: a.artwork?.url?.replace('{w}', '1000').replace('{h}', '1000'),
    extra: { ...(a.previews?.[0]?.url ? { preview: a.previews[0].url } : {}), ...(a.releaseDate ? { released: a.releaseDate } : {}) },
  };
}

/** Storefront (country catalog): from the link, else the Chinese one for searches. */
const storefrontOf = (url: string) => url.match(/music\.apple\.com\/([a-z]{2})\//)?.[1] ?? 'cn';

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const r = await amp<{ results?: { songs?: { data?: Song[] } } }>(`/v1/catalog/cn/search?term=${encodeURIComponent(query)}&types=songs&limit=25`, signal);
  return (r.results?.songs?.data ?? []).map(toTrack).filter((t): t is Track => !!t);
}

async function collection(kind: 'albums' | 'playlists', sf: string, id: string, signal?: AbortSignal): Promise<TrackList> {
  const r = await amp<{ data?: { attributes?: { name?: string }; relationships?: { tracks?: { data?: Song[]; next?: string } } }[] }>(`/v1/catalog/${sf}/${kind}/${id}`, signal);
  const c = r.data?.[0];
  if (!c) throw new FatalError(kind === 'albums' ? '专辑不存在。' : '歌单不存在。');
  const songs = [...(c.relationships?.tracks?.data ?? [])];
  for (let next = c.relationships?.tracks?.next, i = 0; next && i < 50; i++) {
    const page = await amp<{ data?: Song[]; next?: string }>(next, signal);
    songs.push(...(page.data ?? []));
    next = page.next;
  }
  const tracks = songs.map(toTrack).filter((t): t is Track => !!t);
  return { title: c.attributes?.name ?? 'Apple Music', kind: kind === 'albums' ? 'album' : 'playlist', tracks };
}

export const apple: MusicProvider = {
  source: 'apple',
  name: 'Apple Music',
  matchOnly: true,
  async list(url, signal) {
    const sf = storefrontOf(url);
    const songId = new URL(url).searchParams.get('i') ?? url.match(/\/song\/(?:[^/]+\/)?(\d+)/)?.[1];
    if (songId) {
      const r = await amp<{ data?: Song[] }>(`/v1/catalog/${sf}/songs/${songId}`, signal);
      const t = r.data?.[0] ? toTrack(r.data[0]) : undefined;
      if (!t) throw new FatalError('歌曲不存在。');
      return { title: t.title, kind: 'track', tracks: [t] };
    }
    const albumId = url.match(/\/album\/(?:[^/]+\/)?(\d+)/)?.[1];
    if (albumId) return collection('albums', sf, albumId, signal);
    const playlistId = url.match(/\/playlist\/(?:[^/]+\/)?(pl\.[\w-]+)/)?.[1];
    if (playlistId) return collection('playlists', sf, playlistId, signal);
    throw new FatalError('没有识别出 Apple Music 的歌曲、专辑或歌单。');
  },
  search,
};
