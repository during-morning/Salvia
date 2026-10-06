import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FatalError, HttpError, cacheDir, captureRequests, getText, proxiedFetch } from '@salvia/core';
import type { Track, TrackList } from '@salvia/music';

/**
 * Spotify metadata without an account or API key, the way open.spotify.com gets it.
 *
 * The web player talks to a GraphQL endpoint (api-partner …/pathfinder) with "persisted queries":
 * each operation is named and identified by a hash that ships in the player's public JavaScript.
 * Salvia reads those hashes from the scripts, takes the anonymous session headers the page itself
 * uses (a hidden browser window opens one public page and they are copied from its first request),
 * and then asks for exactly what a visitor's page would: search results, a whole playlist page by
 * page, an album, an artist's top tracks. Metadata only — the audio is DRM-protected and is never
 * fetched from Spotify.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PATHFINDER = /api-partner\.spotify\.com\/pathfinder/;
/** A public editorial playlist whose page reliably makes a pathfinder request. */
const SEED_PAGE = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
const SESSION_MS = 40 * 60_000;
const OPS_MS = 24 * 3600_000;

// ---------- operation hashes (from the web player's scripts, cached for a day) ----------

let ops: { at: number; map: Record<string, string> } | undefined;

async function operations(signal?: AbortSignal): Promise<Record<string, string>> {
  if (ops && Date.now() - ops.at < OPS_MS) return ops.map;
  const file = join(cacheDir('spotify'), 'operations.json');
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { at: number; map: Record<string, string> };
    if (Date.now() - saved.at < OPS_MS && saved.map.searchTracks) return (ops = saved).map;
  } catch {
    // fetch below
  }
  const html = await getText('https://open.spotify.com/', { headers: { 'user-agent': UA }, signal });
  const main = html.match(/src="([^"]*\/web-player\/web-player\.[0-9a-f]+\.js)"/)?.[1];
  if (!main) throw new FatalError('读取 Spotify 网页播放器失败（页面结构变了）。');
  const js = await getText(main, { headers: { 'user-agent': UA }, signal, timeout: 60_000 });
  const map: Record<string, string> = {};
  const collect = (src: string) => {
    for (const m of src.matchAll(/"(\w+)","(?:query|mutation)","([0-9a-f]{64})"/g)) map[m[1]!] ??= m[2]!;
  };
  collect(js);
  // Search lives in a chunk loaded on demand: `({id:"name"})[e]||e)+"."+({id:"hash"})[e]+".js"`.
  const chunks = js.match(/\(\{([^{}]*)\}\)\[e\]\|\|e\)\+"\."\+\(\{([^{}]*)\}\)\[e\]\+"\.js"/);
  if (chunks) {
    const table = (s: string) => Object.fromEntries([...s.matchAll(/(\d+):"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    const names = table(chunks[1]!);
    const hashes = table(chunks[2]!);
    const base = main.slice(0, main.lastIndexOf('/') + 1);
    for (const [id, name] of Object.entries(names)) {
      if (!/search/.test(name) || !hashes[id]) continue;
      collect(await getText(`${base}${name}.${hashes[id]}.js`, { headers: { 'user-agent': UA }, signal }).catch(() => ''));
    }
  }
  if (!map.searchTracks || !map.fetchPlaylist) throw new FatalError('没有在 Spotify 网页播放器里找到需要的接口。');
  ops = { at: Date.now(), map };
  writeFileSync(file, JSON.stringify(ops));
  return map;
}

// ---------- session headers (from one public page in a hidden window) ----------

let session: { at: number; url: string; headers: Record<string, string> } | undefined;

async function webSession(signal?: AbortSignal, fresh = false): Promise<NonNullable<typeof session>> {
  if (!fresh && session && Date.now() - session.at < SESSION_MS) return session;
  // Kept on disk too, so separate runs (`salvia "@music:spotify …"`) don't each open a window.
  const file = join(cacheDir('spotify'), 'session.json');
  if (!fresh) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as NonNullable<typeof session>;
      if (Date.now() - saved.at < SESSION_MS && saved.headers.authorization) return (session = saved);
    } catch {
      // open a page below
    }
  }
  const got = await captureRequests(SEED_PAGE, PATHFINDER, { signal, done: (g) => g.some((r) => r.status === 200), maxMs: 40_000 });
  const first = got.find((r) => r.status === 200);
  if (!first) throw new FatalError('打开 Spotify 网页失败，稍后再试。');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(first.headers)) {
    if (/^(authorization|client-token|app-platform|spotify-app-version|accept-language)$/i.test(k)) headers[k.toLowerCase()] = v;
  }
  session = { at: Date.now(), url: first.url.split('?')[0]!, headers };
  writeFileSync(file, JSON.stringify(session));
  return session;
}

/** One persisted query. Retries once with a new session (tokens last about an hour). */
async function query<T>(operation: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const hash = (await operations(signal))[operation];
  if (!hash) throw new FatalError(`Spotify 网页接口 ${operation} 不可用。`);
  for (let attempt = 0; ; attempt++) {
    const s = await webSession(signal, attempt > 0);
    const res = await proxiedFetch(s.url, {
      method: 'POST',
      headers: { ...s.headers, 'content-type': 'application/json;charset=UTF-8', 'user-agent': UA },
      body: JSON.stringify({ variables, operationName: operation, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      signal,
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (!res.ok) throw new HttpError(res.status, s.url, `Spotify 网页接口 HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!body.data) throw new FatalError(`Spotify：${body.errors?.[0]?.message ?? '没有数据'}`);
    return body.data;
  }
}

// ---------- shapes ----------

interface Image {
  url: string;
  width?: number | null;
}
interface WebTrack {
  __typename?: string;
  uri?: string;
  id?: string;
  name?: string;
  duration?: { totalMilliseconds?: number };
  trackDuration?: { totalMilliseconds?: number };
  contentRating?: { label?: string };
  artists?: { items?: { profile?: { name?: string } }[] };
  albumOfTrack?: { name?: string; coverArt?: { sources?: Image[] } };
  playability?: { playable?: boolean };
}

const idOf = (uri?: string) => uri?.split(':').pop() ?? '';
const largest = (sources?: Image[]) => sources?.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;

function toTrack(t: WebTrack, album?: { name?: string; cover?: string }): Track | undefined {
  if (!t || (t.__typename && t.__typename !== 'Track') || !t.name) return undefined;
  const ms = t.duration?.totalMilliseconds ?? t.trackDuration?.totalMilliseconds;
  return {
    id: t.id ?? idOf(t.uri),
    source: 'spotify',
    title: t.name,
    artists: t.artists?.items?.map((a) => a.profile?.name ?? '').filter(Boolean) ?? [],
    album: t.albumOfTrack?.name ?? album?.name,
    duration: ms ? Math.round(ms / 1000) : undefined,
    cover: largest(t.albumOfTrack?.coverArt?.sources) ?? album?.cover,
    explicit: t.contentRating?.label === 'EXPLICIT',
  };
}

// ---------- what Salvia asks for ----------

export async function webSearch(term: string, signal?: AbortSignal, limit = 20): Promise<Track[]> {
  const data = await query<{ searchV2: { tracksV2?: { items?: { item?: { data?: WebTrack } }[] } } }>(
    'searchTracks',
    { searchTerm: term, offset: 0, limit, numberOfTopResults: 5, includeAudiobooks: false, includePreReleases: false, includeAuthors: false },
    signal,
  );
  return (data.searchV2.tracksV2?.items ?? []).map((i) => toTrack(i.item?.data ?? {})).filter((t): t is Track => !!t);
}

/** A whole playlist, 100 tracks per request (the embed page stops at about 100). */
export async function webPlaylist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const tracks: Track[] = [];
  let title = 'Spotify 歌单';
  for (let offset = 0; offset < 10_000; offset += 100) {
    const data = await query<{
      playlistV2: { name?: string; content?: { totalCount?: number; items?: { itemV2?: { data?: WebTrack } }[] } };
    }>('fetchPlaylist', { uri: `spotify:playlist:${id}`, offset, limit: 100, enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: false }, signal);
    const p = data.playlistV2;
    title = p.name ?? title;
    const items = p.content?.items ?? [];
    for (const i of items) {
      const t = toTrack(i.itemV2?.data ?? {});
      if (t) tracks.push(t);
    }
    if (!items.length || offset + items.length >= (p.content?.totalCount ?? 0)) break;
  }
  if (!tracks.length) throw new FatalError('歌单是空的，或者不是公开歌单。');
  return { title, kind: 'playlist', tracks };
}

export async function webAlbum(id: string, signal?: AbortSignal): Promise<TrackList> {
  const tracks: Track[] = [];
  let name = '专辑';
  let cover: string | undefined;
  let artists: string[] = [];
  for (let offset = 0; offset < 2000; offset += 300) {
    const data = await query<{
      albumUnion: {
        name?: string;
        coverArt?: { sources?: Image[] };
        artists?: { items?: { profile?: { name?: string } }[] };
        tracksV2?: { totalCount?: number; items?: { track?: WebTrack }[] };
      };
    }>('getAlbum', { uri: `spotify:album:${id}`, locale: '', offset, limit: 300 }, signal);
    const a = data.albumUnion;
    name = a.name ?? name;
    cover ??= largest(a.coverArt?.sources);
    if (!artists.length) artists = a.artists?.items?.map((x) => x.profile?.name ?? '').filter(Boolean) ?? [];
    const items = a.tracksV2?.items ?? [];
    for (const i of items) {
      const t = toTrack(i.track ?? {}, { name, cover });
      if (t) tracks.push({ ...t, artists: t.artists.length ? t.artists : artists });
    }
    if (!items.length || offset + items.length >= (a.tracksV2?.totalCount ?? 0)) break;
  }
  if (!tracks.length) throw new FatalError('专辑不存在。');
  return { title: name, kind: 'album', tracks };
}

export async function webArtist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const data = await query<{
    artistUnion: { profile?: { name?: string }; discography?: { topTracks?: { items?: { track?: WebTrack }[] } } };
  }>('queryArtistOverview', { uri: `spotify:artist:${id}`, locale: '', preReleaseV2: false }, signal);
  const a = data.artistUnion;
  const tracks = (a.discography?.topTracks?.items ?? []).map((i) => toTrack(i.track ?? {})).filter((t): t is Track => !!t);
  if (!tracks.length) throw new FatalError('没有找到这位歌手的热门歌曲。');
  return { title: `${a.profile?.name ?? '歌手'} · 热门歌曲`, kind: 'artist', tracks };
}

export async function webTrack(id: string, signal?: AbortSignal): Promise<TrackList> {
  const data = await query<{ trackUnion: WebTrack & { firstArtist?: { items?: { profile?: { name?: string } }[] }; otherArtists?: { items?: { profile?: { name?: string } }[] } } }>(
    'getTrack',
    { uri: `spotify:track:${id}` },
    signal,
  );
  const u = data.trackUnion;
  const artists = [...(u.firstArtist?.items ?? []), ...(u.otherArtists?.items ?? [])].map((a) => a.profile?.name ?? '').filter(Boolean);
  const t = toTrack({ ...u, __typename: 'Track', artists: { items: artists.map((name) => ({ profile: { name } })) } });
  if (!t) throw new FatalError('歌曲不存在。');
  return { title: t.title, kind: 'track', tracks: [t] };
}
