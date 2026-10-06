import { FatalError, getJson, getText, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { PC_UA, cleanText, first, lrcTime, num, splitArtists } from '@salvia/music';

/**
 * 酷我音乐 (protocol as in guohuiyuan/music-lib, reimplemented). Search, songs, albums, playlists,
 * lyrics. Paid songs (PAY set) are only offered with the user's own login: Salvia doesn't use
 * client tricks to unlock them, nor music-lib's faked "Secret" header fallback.
 */

const HEADERS = { 'user-agent': PC_UA, referer: 'http://www.kuwo.cn/' };

function auth(): Record<string, string> {
  const c = loadConfig().cookies.kuwo;
  return c ? { cookie: c } : {};
}

/** "level:ff,bitrate:2000,format:flac,size:28.66Mb;level:p,bitrate:320,format:mp3,size:10.4Mb" */
export function parseMinfo(minfo: string): { bitrate: number; format: string; size: number }[] {
  return (minfo ?? '')
    .split(';')
    .map((part) => Object.fromEntries(part.split(',').map((kv) => kv.split(':') as [string, string])))
    .filter((f) => f.format)
    .map((f) => ({ bitrate: num(f.bitrate), format: String(f.format), size: Math.round(parseFloat(String(f.size ?? '0')) * 1024 * 1024) }));
}

interface SearchItem {
  MUSICRID?: string;
  SONGNAME?: string;
  ARTIST?: string;
  ALBUM?: string;
  ALBUMID?: string;
  DURATION?: string;
  hts_MVPIC?: string;
  web_albumpic_short?: string;
  MINFO?: string;
  PAY?: string;
  bitSwitch?: number;
}

const paid = (pay?: string) => !!pay && pay !== '0' && !loadConfig().cookies.kuwo;

function cover(short?: string): string | undefined {
  if (!short) return undefined;
  return short.startsWith('http') ? short : `https://img1.kuwo.cn/star/albumcover/${short.replace(/^120\//, '500/')}`;
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const params = new URLSearchParams({
    vipver: '1',
    client: 'kt',
    ft: 'music',
    cluster: '0',
    strategy: '2012',
    encoding: 'utf8',
    rformat: 'json',
    mobi: '1',
    issubtitle: '1',
    show_copyright_off: '1',
    pn: '0',
    rn: '20',
    all: query,
  });
  const r = await getJson<{ abslist?: SearchItem[] }>(`http://www.kuwo.cn/search/searchMusicBykeyWord?${params}`, { headers: { ...HEADERS, ...auth() }, signal });
  return (r.abslist ?? [])
    .filter((i) => i.MUSICRID && i.bitSwitch !== 0)
    .map((i) => {
      const rid = i.MUSICRID!.replace(/^MUSIC_/, '');
      const formats = parseMinfo(i.MINFO ?? '');
      return {
        id: rid,
        source: 'kuwo' as const,
        title: cleanText(i.SONGNAME),
        artists: splitArtists(i.ARTIST),
        album: cleanText(i.ALBUM) || undefined,
        duration: num(i.DURATION) || undefined,
        cover: cover(i.web_albumpic_short) ?? (i.hts_MVPIC || undefined),
        playable: paid(i.PAY) ? false : undefined,
        extra: { formats: JSON.stringify(formats), albumId: i.ALBUMID ?? '' },
      };
    });
}

const LEVELS: { br: string; label: string; ext: Quality['ext']; kbps: number }[] = [
  { br: '2000kflac', label: '无损 FLAC', ext: 'flac', kbps: 2000 },
  { br: '320kmp3', label: '320k MP3', ext: 'mp3', kbps: 320 },
  { br: '128kmp3', label: '128k MP3', ext: 'mp3', kbps: 128 },
];

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  if (t.playable === false) return [];
  const known = t.extra?.formats ? (JSON.parse(String(t.extra.formats)) as ReturnType<typeof parseMinfo>) : [];
  const user = `C_APK_guanwang_${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const answers = await Promise.all(
    LEVELS.map((l) =>
      getJson<{ data?: { url?: string; bitrate?: number; format?: string } }>(
        `https://mobi.kuwo.cn/mobi.s?${new URLSearchParams({ f: 'web', source: 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk', from: 'PC', type: 'convert_url_with_sign', br: l.br, rid: t.id, user })}`,
        { headers: { ...HEADERS, ...auth() }, signal },
      ).catch(() => undefined),
    ),
  );
  const seen = new Set<string>();
  return LEVELS.flatMap((l, i) => {
    const d = answers[i]?.data;
    if (!d?.url || seen.has(d.url)) return [];
    seen.add(d.url);
    // The server answers with the best it allows up to `br`; label by what came back.
    const kbps = num(d.bitrate) || l.kbps;
    const ext: Quality['ext'] = /flac/i.test(d.format ?? d.url) ? 'flac' : 'mp3';
    const level = LEVELS.find((x) => x.kbps === kbps && x.ext === ext) ?? l;
    const size = known.find((f) => f.format === ext && f.bitrate === kbps)?.size;
    return [{ id: level.br, label: level.label, ext, kbps, size, url: d.url }];
  });
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const r = await getJson<{ data?: { lrclist?: { time: string; lineLyric: string }[] } }>(
    `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${t.id}&httpsStatus=1`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  const lines = r.data?.lrclist ?? [];
  if (!lines.length) return undefined;
  return { lrc: lines.map((l) => lrcTime(Math.round(parseFloat(l.time) * 1000)) + l.lineLyric).join('\n') };
}

async function song(rid: string, signal?: AbortSignal): Promise<TrackList> {
  const r = await getJson<{ data?: { songinfo?: { songName?: string; artist?: string; album?: string; pic?: string; duration?: string } } }>(
    `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}&httpsStatus=1`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  const s = r.data?.songinfo;
  if (!s?.songName) throw new FatalError('歌曲不存在。');
  const t: Track = { id: rid, source: 'kuwo', title: cleanText(s.songName), artists: splitArtists(s.artist), album: s.album, cover: s.pic, duration: num(s.duration) || undefined };
  return { title: t.title, kind: 'track', tracks: [t] };
}

/** The legacy endpoints answer JS-ish objects with single quotes. */
function looseJson<T>(text: string): T {
  return JSON.parse(text.replace(/'/g, '"').replace(/&nbsp;/g, ' ')) as T;
}

interface ListItem {
  id?: string;
  musicrid?: string;
  name?: string;
  song_name?: string;
  artist?: string;
  artist_name?: string;
  album?: string;
  albumpic?: string;
  duration?: string | number;
}

function fromList(i: ListItem, album?: string): Track | undefined {
  const rid = first(i.id, i.musicrid).replace(/^MUSIC_/, '');
  if (!rid) return undefined;
  return {
    id: rid,
    source: 'kuwo',
    title: cleanText(first(i.name, i.song_name)),
    artists: splitArtists(first(i.artist, i.artist_name)),
    album: cleanText(first(i.album, album)) || undefined,
    cover: i.albumpic || undefined,
    duration: num(i.duration) || undefined,
  };
}

async function album(id: string, signal?: AbortSignal): Promise<TrackList> {
  const params = `pn=0&rn=300&stype=albuminfo&albumid=${id}&sortby=0&alflac=1&show_copyright_off=1&pcmp4=1&encoding=utf8`;
  const text = await getText(`http://search.kuwo.cn/r.s?${params}`, { headers: { ...HEADERS, ...auth() }, signal });
  const r = looseJson<{ name?: string; musiclist?: ListItem[] }>(text);
  const tracks = (r.musiclist ?? []).map((i) => fromList(i, r.name)).filter((t): t is Track => !!t);
  if (!tracks.length) throw new FatalError('专辑不存在。');
  return { title: cleanText(r.name) || '酷我专辑', kind: 'album', tracks };
}

async function playlist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const tracks: Track[] = [];
  let title = '酷我歌单';
  for (let pn = 0; pn < 20; pn++) {
    const params = new URLSearchParams({ op: 'getlistinfo', pid: id, pn: String(pn), rn: '100', encode: 'utf8', keyset: 'pl2012', identity: 'kuwo', pcmp4: '1', vipver: '1', newver: '1' });
    const r = await getJson<{ title?: string; total?: number | string; musiclist?: ListItem[] }>(`http://nplserver.kuwo.cn/pl.svc?${params}`, { headers: { ...HEADERS, ...auth() }, signal });
    title = cleanText(r.title) || title;
    const items = r.musiclist ?? [];
    tracks.push(...items.map((i) => fromList(i)).filter((t): t is Track => !!t));
    if (items.length < 100 || tracks.length >= num(r.total)) break;
  }
  if (!tracks.length) throw new FatalError('歌单不存在。');
  return { title, kind: 'playlist', tracks };
}

export const kuwo: MusicProvider = {
  source: 'kuwo',
  name: '酷我音乐',
  headers: HEADERS,
  async list(url, signal) {
    const rid =
      url.match(/play_detail\/(\d+)/)?.[1] ??
      url.match(/[?&](?:rid|musicId|musicid|mid)=(?:MUSIC_)?(\d+)/)?.[1] ??
      url.match(/\/(?:singles|yinyue|music)\/(\d+)/)?.[1];
    if (rid) return song(rid, signal);
    const albumId = url.match(/album_detail\/(\d+)/)?.[1];
    if (albumId) return album(albumId, signal);
    const pid = url.match(/playlist_detail\/(\d+)/)?.[1] ?? url.match(/[?&]pid=(\d+)/)?.[1];
    if (pid) return playlist(pid, signal);
    throw new FatalError('没有识别出酷我的歌曲、专辑或歌单编号。');
  },
  search,
  qualities,
  lyrics,
};
