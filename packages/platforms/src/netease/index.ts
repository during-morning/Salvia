import { CookieJar, FatalError, getJson, loadConfig, request } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { eapiEncrypt } from './eapi.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154';
const HEADERS = { 'user-agent': UA, referer: 'https://music.163.com/' };

/** Cookies the desktop client sends. Without os=pc the url endpoint returns low bitrates. */
function jar(): CookieJar {
  const j = new CookieJar('os=pc; appver=8.9.75; osver=; deviceId=salvia');
  const user = loadConfig().cookies.netease;
  if (user) j.parse(user);
  return j;
}

async function api<T>(url: string, form: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const body = await getJson<T & { code?: number; message?: string; msg?: string }>(url, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    jar: jar(),
    signal,
  });
  if (body.code !== undefined && body.code !== 200) {
    throw new FatalError(`网易云返回错误 ${body.code}：${body.message ?? body.msg ?? ''}`);
  }
  return body;
}

/** POST an eapi endpoint: `/eapi/…` on the wire, signed as `/api/…`. */
function eapi<T>(path: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const header = { os: 'pc', appver: '', osver: '', deviceId: 'salvia', requestId: String(Date.now() % 1e7) };
  const params = eapiEncrypt(path, { ...data, header: JSON.stringify(header) });
  return api<T>(`https://interface3.music.163.com/e${path.slice(1)}`, { params }, signal);
}

interface RawSong {
  id: number;
  name: string;
  ar: { name: string }[];
  al: { id?: number; name: string; picUrl?: string };
  dt: number;
  fee: number;
  mark?: number;
}
interface Privilege {
  id: number;
  st: number;
  pl: number;
  fee: number;
}

function toTrack(s: RawSong, p?: Privilege): Track {
  return {
    id: String(s.id),
    source: 'netease',
    title: s.name,
    artists: s.ar.map((a) => a.name).filter(Boolean),
    album: s.al?.name || undefined,
    duration: s.dt ? Math.round(s.dt / 1000) : undefined,
    cover: s.al?.picUrl ? `${s.al.picUrl}?param=1000y1000` : undefined,
    explicit: s.mark !== undefined ? (s.mark & 1048576) !== 0 : undefined,
    // st < 0: removed or blocked here; pl = 0: no play right (VIP-only or region).
    playable: p ? p.st >= 0 && p.pl > 0 : undefined,
    extra: s.al?.id ? { albumId: s.al.id } : undefined,
  };
}

async function details(ids: string[], signal?: AbortSignal): Promise<Track[]> {
  const out: Track[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const res = await api<{ songs: RawSong[]; privileges: Privilege[] }>(
      'https://interface3.music.163.com/api/v3/song/detail',
      { c: JSON.stringify(batch.map((id) => ({ id: Number(id), v: 0 }))) },
      signal,
    );
    const priv = new Map(res.privileges.map((p) => [p.id, p]));
    out.push(...res.songs.map((s) => toTrack(s, priv.get(s.id))));
  }
  return out;
}

// Best first. Labels match the NetEase client.
const LEVELS: { level: string; label: string }[] = [
  { level: 'hires', label: 'Hi-Res' },
  { level: 'lossless', label: '无损' },
  { level: 'exhigh', label: '极高 320k' },
  { level: 'standard', label: '标准 128k' },
];

interface SongUrl {
  id: number;
  url: string | null;
  br: number;
  size: number;
  type: string | null;
  level: string;
  freeTrialInfo: unknown;
  code: number;
}

export async function parseNetease(input: string, signal?: AbortSignal): Promise<{ type: string; id: string }> {
  let url = input;
  if (/163cn\.tv/.test(url)) {
    const res = await request(url, { redirect: 'manual', signal, retries: 1 });
    await res.body?.cancel();
    url = res.headers.get('location') ?? url;
  }
  // Both https://music.163.com/#/song?id=1 and /song?id=1 and /m/song?id=1
  const plain = url.replace('/#/', '/');
  const m =
    plain.match(/\/(song|album|playlist|artist|discover\/toplist)\b[^?]*\?(?:.*&)?id=(\d+)/) ??
    plain.match(/\/(song|album|playlist|artist)\/(\d+)/);
  if (!m) throw new FatalError('没有识别出网易云的歌曲、专辑或歌单编号。');
  return { type: m[1] === 'discover/toplist' ? 'playlist' : m[1]!, id: m[2]! };
}

export const netease: MusicProvider = {
  source: 'netease',
  name: '网易云',
  headers: HEADERS,

  async list(url, signal): Promise<TrackList> {
    const { type, id } = await parseNetease(url, signal);
    if (type === 'song') {
      const tracks = await details([id], signal);
      if (!tracks.length) throw new FatalError('歌曲不存在。');
      return { title: tracks[0]!.title, kind: 'track', tracks };
    }
    if (type === 'album') {
      const res = await getJson<{ code: number; album: { name: string; picUrl: string }; songs: RawSong[] }>(
        `https://music.163.com/api/v1/album/${id}`,
        { headers: HEADERS, jar: jar(), signal },
      );
      if (res.code !== 200) throw new FatalError('专辑不存在。');
      // Album songs lack privileges; fetch details for playability.
      const tracks = await details(res.songs.map((s) => String(s.id)), signal);
      return { title: res.album.name, kind: 'album', tracks };
    }
    if (type === 'artist') {
      const res = await getJson<{ code: number; artist: { name: string }; hotSongs: RawSong[] }>(
        `https://music.163.com/api/artist/${id}`,
        { headers: HEADERS, jar: jar(), signal },
      );
      if (res.code !== 200) throw new FatalError('歌手不存在。');
      const tracks = await details(res.hotSongs.map((s) => String(s.id)), signal);
      return { title: `${res.artist.name} · 热门歌曲`, kind: 'artist', tracks };
    }
    const res = await api<{ playlist: { name: string; trackIds: { id: number }[] } }>(
      'https://music.163.com/api/v6/playlist/detail',
      { id, n: '100000', s: '8' },
      signal,
    );
    const tracks = await details(res.playlist.trackIds.map((t) => String(t.id)), signal);
    return { title: res.playlist.name, kind: 'playlist', tracks };
  },

  async search(query, signal) {
    const res = await api<{ result?: { songs?: RawSong[] } }>(
      'https://music.163.com/api/cloudsearch/pc',
      { s: query, type: '1', limit: '20', offset: '0' },
      signal,
    );
    const songs = res.result?.songs ?? [];
    // Search results carry a privilege object too.
    return songs.map((s) => toTrack(s, (s as RawSong & { privilege?: Privilege }).privilege));
  },

  async qualities(track, signal) {
    const ask = (level: string) =>
      eapi<{ data: SongUrl[] }>(
        '/api/song/enhance/player/url/v1',
        { ids: JSON.stringify([Number(track.id)]), level, encodeType: 'flac' },
        signal,
      ).then((r) => r.data[0]);
    // The server answers with the best it allows up to `level`; ask each level and keep distinct results.
    const results = await Promise.all(LEVELS.map((l) => ask(l.level).catch(() => undefined)));
    const seen = new Set<number>();
    const out: Quality[] = [];
    for (const r of results) {
      if (!r?.url || seen.has(r.br)) continue;
      seen.add(r.br);
      const label = LEVELS.find((l) => l.level === r.level)?.label ?? `${Math.round(r.br / 1000)}k`;
      const ext = (r.type ?? 'mp3').toLowerCase() === 'flac' ? 'flac' : 'mp3';
      out.push({ id: r.level, label, ext, size: r.size, url: r.url, trial: !!r.freeTrialInfo });
    }
    return out;
  },

  async intro(track, signal) {
    const id = track.extra?.albumId;
    if (!id) return undefined;
    const res = await getJson<{ album?: { description?: string; publishTime?: number; company?: string } }>(
      `https://music.163.com/api/v1/album/${id}`,
      { headers: HEADERS, jar: jar(), signal },
    );
    const a = res.album;
    return {
      text: a?.description?.trim() || undefined,
      released: a?.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : undefined,
      company: a?.company || undefined,
    };
  },

  async lyrics(track, signal): Promise<Lyrics | undefined> {
    const res = await api<{ lrc?: { lyric?: string }; tlyric?: { lyric?: string } }>(
      'https://interface3.music.163.com/api/song/lyric',
      { id: track.id, cp: 'false', lv: '0', tv: '0', rv: '0', kv: '0', yv: '0', ytv: '0', yrv: '0' },
      signal,
    );
    const lrc = res.lrc?.lyric?.trim();
    if (!lrc) return undefined;
    return { lrc, translation: res.tlyric?.lyric?.trim() || undefined };
  },
};
