import { CookieJar, FatalError, getJson, loadConfig, request } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { zzcSign } from './sign.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, referer: 'https://y.qq.com/' };

function login(): { uin: string; key?: string; jar: CookieJar } {
  const jar = new CookieJar(loadConfig().cookies.qq);
  const uin = (jar.get('uin') ?? jar.get('wxuin') ?? '0').replace(/^o0*/, '') || '0';
  const key = jar.get('qqmusic_key') ?? jar.get('qm_keyst');
  return { uin, key, jar };
}

type Req = { module: string; method: string; param: Record<string, unknown> };

/** Signed musics.fcg call with one or more module requests; returns each request's `data`. */
async function musicu<T extends Record<string, unknown>>(reqs: Record<string, Req>, signal?: AbortSignal): Promise<T> {
  const res = await musicuRaw(reqs, signal);
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(reqs)) {
    const r = res[name];
    if (!r || r.code !== 0) throw new FatalError(`QQ音乐接口 ${reqs[name]!.method} 返回错误 ${r?.code ?? '?'}`);
    out[name] = r.data;
  }
  return out as T;
}

/** One signed request carrying several modules; each answer is checked by the caller. */
async function musicuRaw(reqs: Record<string, Req>, signal?: AbortSignal): Promise<Record<string, { code: number; data: unknown } | undefined>> {
  const { uin, key, jar } = login();
  const comm: Record<string, unknown> = { ct: 24, cv: 0, format: 'json', uin };
  if (key) comm.authst = key;
  const body = JSON.stringify({ comm, ...reqs });
  const res = await getJson<Record<string, { code: number; data: unknown }> & { code: number }>(
    `https://u.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&sign=${zzcSign(body)}`,
    { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body, jar, signal },
  );
  if (res.code !== 0) throw new FatalError(`QQ音乐返回错误 ${res.code}`);
  return res;
}

interface RawSong {
  mid: string;
  name: string;
  title?: string;
  interval: number;
  singer: { name: string }[];
  album: { mid: string; name: string };
  file: Record<string, number | string> & { media_mid: string };
  pay?: { pay_play?: number };
}

function cover(albumMid?: string): string | undefined {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${albumMid}.jpg` : undefined;
}

function toTrack(s: RawSong): Track {
  const vip = s.pay?.pay_play === 1;
  return {
    id: s.mid,
    source: 'qq',
    title: s.title || s.name,
    artists: s.singer.map((x) => x.name),
    album: s.album?.name || undefined,
    duration: s.interval || undefined,
    cover: cover(s.album?.mid),
    // VIP tracks may still be playable for a logged-in member; leave unknown then.
    playable: vip ? (login().key ? undefined : false) : undefined,
    extra: { mediaMid: s.file?.media_mid ?? s.mid, ...sizes(s.file) },
  };
}

/**
 * Formats by file-name prefix, best first, with the `file` size field that tells if it exists
 * (`size_new.N` = N-th entry of the `size_new` array). Prefixes as in Suxiaoqinx/tencent_url.
 */
const FORMATS: { prefix: string; ext: Quality['ext']; label: string; size: string }[] = [
  { prefix: 'AI00', ext: 'flac', label: '臻品母带 Master', size: 'size_new.0' },
  { prefix: 'Q000', ext: 'flac', label: '臻品全景声 2.0', size: 'size_new.1' },
  { prefix: 'Q001', ext: 'flac', label: '臻品全景声 5.1', size: 'size_new.2' },
  { prefix: 'RS01', ext: 'flac', label: 'Hi-Res 无损', size: 'size_hires' },
  { prefix: 'F000', ext: 'flac', label: '无损 FLAC', size: 'size_flac' },
  { prefix: 'M800', ext: 'mp3', label: '320k MP3', size: 'size_320mp3' },
  { prefix: 'O800', ext: 'ogg', label: '320k OGG', size: 'size_320ogg' },
  { prefix: 'C600', ext: 'm4a', label: '192k AAC', size: 'size_192aac' },
  { prefix: 'O600', ext: 'ogg', label: '192k OGG', size: 'size_192ogg' },
  { prefix: 'M500', ext: 'mp3', label: '128k MP3', size: 'size_128mp3' },
  { prefix: 'C400', ext: 'm4a', label: '96k AAC', size: 'size_96aac' },
  { prefix: 'C200', ext: 'm4a', label: '48k AAC', size: 'size_48aac' },
];

function sizes(file?: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FORMATS) {
    const [key, index] = f.size.split('.');
    const raw = file?.[key!];
    const n = Number(index !== undefined ? (Array.isArray(raw) ? raw[Number(index)] : 0) : (raw ?? 0));
    if (n > 0) out[f.size] = n;
  }
  return out;
}

const SONG_FIELDS = (x: { songInfo?: RawSong } & Partial<RawSong>): RawSong => (x.songInfo ?? x) as RawSong;

/** Several songs' details in one request (search results), skipping ones that fail. */
async function details(mids: string[], signal?: AbortSignal): Promise<Track[]> {
  if (!mids.length) return [];
  const reqs = Object.fromEntries(
    mids.map((mid, i) => [`req_${i}`, { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: mid } }]),
  );
  const res = await musicuRaw(reqs, signal);
  return mids.flatMap((_, i) => {
    const info = (res[`req_${i}`]?.data as { track_info?: RawSong } | undefined)?.track_info;
    return info?.mid ? [toTrack(info)] : [];
  });
}

async function detail(mid: string, signal?: AbortSignal): Promise<Track> {
  const r = await musicu<{ req: { track_info: RawSong } }>(
    { req: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_mid: mid } } },
    signal,
  );
  if (!r.req.track_info?.mid) throw new FatalError('歌曲不存在。');
  return toTrack(r.req.track_info);
}

/**
 * A search id as the web player makes it (MCQTSS/MCQTSS_QQMusic getsearchid.js): 3 * 2^54 + a
 * random multiple of 2^32 + milliseconds of the day. Without it the search answers empty
 * outside mainland China.
 */
export function searchId(now = new Date(), random = Math.random()): string {
  const ms = ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  return (3n * 18014398509481984n + BigInt(Math.round(random * 4194304)) * 4294967296n + BigInt(ms)).toString();
}

/** Full song search (20 results with file sizes and pay info), the way the h5 player asks. */
async function fullSearch(query: string, signal?: AbortSignal): Promise<RawSong[]> {
  const { uin } = login();
  const body = JSON.stringify({
    comm: { g_tk: 997034911, uin, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'h5', needNewCode: 1, ct: 23, cv: 0 },
    req_0: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { remoteplace: 'txt.mqq.all', searchid: searchId(), search_type: 0, query, page_num: 1, num_per_page: 20 },
    },
  });
  const res = await getJson<{ req_0?: { code: number; data?: { body?: { song?: { list?: RawSong[] } } } } }>(
    `https://u.y.qq.com/cgi-bin/musicu.fcg?_webcgikey=DoSearchForQQMusicDesktop&_=${Date.now()}`,
    { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body, jar: login().jar, signal },
  );
  return res.req_0?.data?.body?.song?.list ?? [];
}

/** A numeric song id (old links, `?id=`) → its songmid. */
async function midFromId(id: string, signal?: AbortSignal): Promise<string> {
  const r = await musicu<{ req: { track_info?: RawSong } }>(
    { req: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq', param: { song_id: Number(id) } } },
    signal,
  );
  if (!r.req.track_info?.mid) throw new FatalError('歌曲不存在。');
  return r.req.track_info.mid;
}

export async function parseQQ(input: string, signal?: AbortSignal): Promise<{ type: string; id: string }> {
  let url = input;
  if (/c6?\.y\.qq\.com\/base\/fcgi-bin\/u/.test(url)) {
    const res = await request(url, { redirect: 'manual', signal, retries: 1 });
    await res.body?.cancel();
    url = res.headers.get('location') ?? url;
  }
  const u = new URL(url);
  const path = u.pathname;
  let m = path.match(/songDetail\/(\w+)/);
  if (m) return { type: 'song', id: /^\d+$/.test(m[1]!) ? await midFromId(m[1]!, signal) : m[1]! };
  m = path.match(/albumDetail\/(\w+)/);
  if (m) return { type: 'album', id: m[1]! };
  m = path.match(/playlist\/(\d+)/);
  if (m) return { type: 'playlist', id: m[1]! };
  m = path.match(/singer\/(\w+)/);
  if (m) return { type: 'singer', id: m[1]! };
  const q = u.searchParams;
  if (/taoge|playlist/.test(path) && q.get('id')) return { type: 'playlist', id: q.get('id')! };
  if (/song/.test(path) && (q.get('songmid') || q.get('mid'))) return { type: 'song', id: (q.get('songmid') ?? q.get('mid'))! };
  // Old share links and the desktop client: a numeric song id.
  const numeric = q.get('songid') ?? (/song/.test(path) ? q.get('id') : null);
  if (numeric && /^\d+$/.test(numeric)) return { type: 'song', id: await midFromId(numeric, signal) };
  if (/album/.test(path) && (q.get('albummid') || q.get('mid'))) return { type: 'album', id: (q.get('albummid') ?? q.get('mid'))! };
  throw new FatalError('没有识别出 QQ音乐的歌曲、专辑或歌单编号。');
}

export const qq: MusicProvider = {
  source: 'qq',
  name: 'QQ音乐',
  headers: HEADERS,

  async list(url, signal): Promise<TrackList> {
    const { type, id } = await parseQQ(url, signal);
    if (type === 'song') {
      const t = await detail(id, signal);
      return { title: t.title, kind: 'track', tracks: [t] };
    }
    if (type === 'album') {
      const r = await musicu<{
        info: { basicInfo: { albumName: string } };
        songs: { songList: { songInfo: RawSong }[] };
      }>(
        {
          info: { module: 'music.musichallAlbum.AlbumInfoServer', method: 'GetAlbumDetail', param: { albumMid: id } },
          songs: {
            module: 'music.musichallAlbum.AlbumSongList',
            method: 'GetAlbumSongList',
            param: { albumMid: id, begin: 0, num: 500, order: 2 },
          },
        },
        signal,
      );
      return { title: r.info.basicInfo.albumName, kind: 'album', tracks: r.songs.songList.map((s) => toTrack(SONG_FIELDS(s))) };
    }
    if (type === 'singer') {
      const r = await musicu<{ req: { singerInfo?: { Name: string }; songList: { songInfo: RawSong }[] } }>(
        {
          req: {
            module: 'musichall.song_list_server',
            method: 'GetSingerSongList',
            param: { singerMid: id, begin: 0, num: 50, order: 1 },
          },
        },
        signal,
      );
      const name = r.req.singerInfo?.Name ?? '歌手';
      return { title: `${name} · 热门歌曲`, kind: 'artist', tracks: r.req.songList.map((s) => toTrack(SONG_FIELDS(s))) };
    }
    const tracks: Track[] = [];
    let title = '歌单';
    for (let begin = 0; begin < 10_000; begin += 500) {
      const r = await musicu<{ req: { dirinfo: { title: string }; total_song_num: number; songlist: RawSong[] } }>(
        {
          req: {
            module: 'music.srfDissInfo.aiDissInfo',
            method: 'uniform_get_Dissinfo',
            param: { disstid: Number(id), userinfo: 1, tag: 1, orderlist: 1, song_begin: begin, song_num: 500, onlysonglist: 0 },
          },
        },
        signal,
      );
      title = r.req.dirinfo?.title ?? title;
      tracks.push(...(r.req.songlist ?? []).map(toTrack));
      if (tracks.length >= r.req.total_song_num || !r.req.songlist?.length) break;
    }
    if (!tracks.length) throw new FatalError('歌单不存在或是私密歌单。');
    return { title, kind: 'playlist', tracks };
  },

  async search(query, signal) {
    const list = await fullSearch(query, signal).catch(() => [] as RawSong[]);
    if (list.length) return list.map(toTrack);
    // Fallback: the suggestion box (a few results, details fetched in one batch).
    const box = await getJson<{ data?: { song?: { itemlist?: { mid: string }[] } } }>(
      `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=${encodeURIComponent(query)}`,
      { headers: HEADERS, signal },
    );
    const mids = box.data?.song?.itemlist?.map((i) => i.mid) ?? [];
    return details(mids, signal);
  },

  async qualities(track, signal) {
    const mediaMid = String(track.extra?.mediaMid ?? track.id);
    // `file` sizes say which formats exist; without them (e.g. smartbox results) ask for all.
    const known = Object.keys(track.extra ?? {}).some((k) => k.startsWith('size_'));
    const available = known ? FORMATS.filter((f) => Number(track.extra?.[f.size] ?? 0) > 0) : FORMATS;
    if (!available.length) return [];
    const { uin } = login();
    const filenames = available.map((f) => `${f.prefix}${mediaMid}.${f.ext}`);
    const r = await musicu<{ req: { sip: string[]; midurlinfo: { filename: string; purl: string }[] } }>(
      {
        req: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: '10000',
            songmid: filenames.map(() => track.id),
            songtype: filenames.map(() => 0),
            uin,
            loginflag: 1,
            platform: '20',
            filename: filenames,
          },
        },
      },
      signal,
    );
    // Every CDN host listed serves the file: the first is used, the others are mirrors for the
    // parallel download (and stand-ins when one fails).
    const sips = (r.req.sip?.length ? r.req.sip : ['https://isure.stream.qqmusic.qq.com/']).map((s) => s.replace(/^http:/, 'https:'));
    const purls = new Map(r.req.midurlinfo.map((m) => [m.filename, m.purl]));
    return available.flatMap((f, i) => {
      const purl = purls.get(filenames[i]!);
      if (!purl) return [];
      const size = Number(track.extra?.[f.size] ?? 0) || undefined;
      const [url, ...mirrors] = sips.map((s) => s + purl);
      return [{ id: f.prefix, label: f.label, ext: f.ext, size, url: url!, mirrors }];
    });
  },

  async lyrics(track, signal): Promise<Lyrics | undefined> {
    const r = await musicu<{ req: { lyric?: string; trans?: string } }>(
      { req: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: { songMID: track.id, trans: 1 } } },
      signal,
    );
    const decode = (b64?: string) => (b64 ? Buffer.from(b64, 'base64').toString('utf8').trim() : '');
    const lrc = decode(r.req.lyric);
    if (lrc) return { lrc, translation: decode(r.req.trans) || undefined };
    // The old web endpoint still has lyrics for some songs the new one doesn't.
    const old = await getJson<{ lyric?: string; trans?: string }>(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=0&songmid=${encodeURIComponent(track.id)}&_=${Date.now()}`,
      { headers: HEADERS, signal },
    ).catch(() => undefined);
    const oldLrc = decode(old?.lyric);
    return oldLrc ? { lrc: oldLrc, translation: decode(old?.trans) || undefined } : undefined;
  },
};
