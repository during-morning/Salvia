import { FatalError, HttpError, findBrowser, followRedirects, getJson, getText, loadConfig } from '@salvia/core';
import type { MusicProvider, Track, TrackList } from '@salvia/music';
import { webAlbum, webArtist, webPlaylist, webSearch, webTrack } from './web.ts';

type Kind = 'track' | 'album' | 'playlist' | 'artist';

export async function parseSpotify(input: string, signal?: AbortSignal): Promise<{ kind: Kind; id: string }> {
  let text = input.trim();
  const uri = text.match(/^spotify:(track|album|playlist|artist):(\w+)$/);
  if (uri) return { kind: uri[1] as Kind, id: uri[2]! };
  if (/spotify\.link\//.test(text)) text = await followRedirects(text, { signal });
  const m = text.match(/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist|artist)\/(\w+)/);
  if (!m) throw new FatalError('没有识别出 Spotify 链接。');
  return { kind: m[1] as Kind, id: m[2]! };
}

// ---------- Web API (when `@spotify <client id> <secret>` is set) ----------

let token: { value: string; until: number; key: string } | undefined;

function credentials(): { id: string; secret: string } | undefined {
  const c = loadConfig().extra.spotify as { id?: string; secret?: string } | undefined;
  return c?.id && c.secret ? { id: c.id, secret: c.secret } : undefined;
}

async function accessToken(signal?: AbortSignal): Promise<string | undefined> {
  const cred = credentials();
  if (!cred) return undefined;
  const key = `${cred.id}:${cred.secret}`;
  if (token && token.key === key && token.until > Date.now()) return token.value;
  const res = await getJson<{ access_token: string; expires_in: number }>('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(key).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal,
  });
  token = { value: res.access_token, until: Date.now() + (res.expires_in - 60) * 1000, key };
  return token.value;
}

interface ApiTrack {
  id: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  artists: { name: string }[];
  album?: { name: string; images: { url: string; width: number }[] };
}

function fromApi(t: ApiTrack, album?: ApiTrack['album']): Track {
  const al = t.album ?? album;
  const img = al?.images?.slice().sort((a, b) => b.width - a.width)[0]?.url;
  return {
    id: t.id,
    source: 'spotify',
    title: t.name,
    artists: t.artists.map((a) => a.name),
    album: al?.name,
    duration: Math.round(t.duration_ms / 1000),
    explicit: t.explicit,
    cover: img,
  };
}

async function viaApi(kind: Kind, id: string, bearer: string, signal?: AbortSignal): Promise<TrackList> {
  const get = <T>(url: string) =>
    getJson<T>(url.startsWith('http') ? url : `https://api.spotify.com/v1/${url}`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal,
    });
  if (kind === 'track') {
    const t = await get<ApiTrack>(`tracks/${id}`);
    return { title: t.name, kind, tracks: [fromApi(t)] };
  }
  if (kind === 'artist') {
    const [a, top] = await Promise.all([
      get<{ name: string }>(`artists/${id}`),
      get<{ tracks: ApiTrack[] }>(`artists/${id}/top-tracks?market=US`),
    ]);
    return { title: `${a.name} · 热门歌曲`, kind, tracks: top.tracks.map((t) => fromApi(t)) };
  }
  if (kind === 'album') {
    const al = await get<{ name: string; images: { url: string; width: number }[]; tracks: Page<ApiTrack> }>(`albums/${id}`);
    const items = await drain(al.tracks, get);
    return { title: al.name, kind, tracks: items.map((t) => fromApi(t, al)) };
  }
  const pl = await get<{ name: string; tracks: Page<{ track: ApiTrack | null }> }>(`playlists/${id}`);
  const items = await drain(pl.tracks, get);
  return { title: pl.name, kind, tracks: items.flatMap((i) => (i.track?.id ? [fromApi(i.track)] : [])) };
}

interface Page<T> {
  items: T[];
  next: string | null;
}

async function drain<T>(first: Page<T>, get: <P>(url: string) => Promise<P>): Promise<T[]> {
  const out = [...first.items];
  for (let next = first.next; next; ) {
    const page = await get<Page<T>>(next);
    out.push(...page.items);
    next = page.next;
  }
  return out;
}

// ---------- Embed page (no credentials) ----------

interface EmbedEntity {
  type: string;
  id?: string;
  name?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  isExplicit?: boolean;
  artists?: { name: string }[];
  coverArt?: { sources?: { url: string; width: number }[] };
  visualIdentity?: { image?: { url: string; maxWidth: number }[] };
  audioPreview?: { url?: string };
  releaseDate?: { isoString?: string };
  trackList?: { uri: string; title: string; subtitle: string; duration: number; isExplicit: boolean }[];
}

function embedCover(e: EmbedEntity): string | undefined {
  const imgs = e.visualIdentity?.image ?? e.coverArt?.sources?.map((s) => ({ url: s.url, maxWidth: s.width }));
  return imgs?.slice().sort((a, b) => b.maxWidth - a.maxWidth)[0]?.url;
}

/** Public embed widget data: names, artists, durations. Lists may be capped (about 100 tracks). */
async function viaEmbed(kind: Kind, id: string, signal?: AbortSignal): Promise<TrackList> {
  const html = await getText(`https://open.spotify.com/embed/${kind}/${id}`, { signal });
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s)?.[1];
  const e = json ? (JSON.parse(json) as { props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } } }).props?.pageProps?.state?.data?.entity : undefined;
  if (!e) throw new FatalError('Spotify 页面没有返回数据，可能链接无效。');
  const cover = embedCover(e);
  if (e.type === 'track') {
    return {
      title: e.name ?? e.title ?? '',
      kind,
      tracks: [
        {
          id,
          source: 'spotify',
          title: e.name ?? e.title ?? '',
          artists: e.artists?.map((a) => a.name) ?? [],
          duration: e.duration ? Math.round(e.duration / 1000) : undefined,
          explicit: e.isExplicit,
          cover,
          // 30-second preview clip (public), and the release date, for the preview pane.
          extra: {
            ...(e.audioPreview?.url ? { preview: e.audioPreview.url } : {}),
            ...(e.releaseDate?.isoString ? { released: e.releaseDate.isoString.slice(0, 10) } : {}),
          },
        },
      ],
    };
  }
  const tracks = (e.trackList ?? []).map<Track>((t) => ({
    id: t.uri.split(':').pop() ?? t.uri,
    source: 'spotify',
    title: t.title,
    artists: t.subtitle.split(/,\s*/).filter(Boolean),
    album: e.type === 'album' ? (e.name ?? e.title) : undefined,
    duration: Math.round(t.duration / 1000),
    explicit: t.isExplicit,
    cover: e.type === 'album' ? cover : undefined,
  }));
  return { title: e.name ?? e.title ?? 'Spotify', kind, tracks };
}

export const spotify: MusicProvider = {
  source: 'spotify',
  name: 'Spotify',
  matchOnly: true,

  async list(url, signal) {
    const { kind, id } = await parseSpotify(url, signal);
    const bearer = await accessToken(signal).catch(() => undefined);
    if (bearer) {
      try {
        return await viaApi(kind, id, bearer, signal);
      } catch (err) {
        // New apps can't read editorial playlists via the API; the web player's data still has them.
        if (!(err instanceof HttpError) || ![403, 404].includes(err.status)) throw err;
      }
    }
    // No account needed: what open.spotify.com loads (whole playlists, albums, artists' top
    // tracks). The embed page is the fallback (playlists stop at about 100 tracks there).
    if (findBrowser()) {
      try {
        if (kind === 'playlist') return await webPlaylist(id, signal);
        if (kind === 'album') return await webAlbum(id, signal);
        if (kind === 'artist') return await webArtist(id, signal);
        return await webTrack(id, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    return viaEmbed(kind, id, signal);
  },

  async search(query, signal) {
    // With the user's own API app, the official search; otherwise the web player's.
    const bearer = await accessToken(signal).catch(() => undefined);
    if (bearer) {
      const res = await getJson<{ tracks: { items: ApiTrack[] } }>(
        `https://api.spotify.com/v1/search?type=track&limit=20&q=${encodeURIComponent(query)}`,
        { headers: { authorization: `Bearer ${bearer}` }, signal, retries: 0 },
      );
      return res.tracks.items.map((t) => fromApi(t));
    }
    if (!findBrowser()) throw new FatalError('Spotify 搜索需要 Chrome 或 Edge（读取网页版数据），或用 @spotify <client id> <client secret> 设置 API 凭据。');
    return webSearch(query, signal);
  },
};

/** The track's own embed page: preview clip, release date, cover. */
export async function spotifyTrack(id: string, signal?: AbortSignal): Promise<Track | undefined> {
  return (await viaEmbed('track', id, signal)).tracks[0];
}

/** Spotify search works: API credentials (@spotify) or a login (@login spotify). */
export function spotifySearchable(): boolean {
  return !!credentials() || !!findBrowser();
}

