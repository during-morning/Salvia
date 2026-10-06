import { inflateSync } from 'node:zlib';
import { FatalError, followRedirects, getJson, getText, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { MOBILE_UA, PC_UA, cleanText, first, num, splitArtists, timedToLrc } from '@salvia/music';

/**
 * 酷狗音乐 (protocol as in guohuiyuan/music-lib, reimplemented). Search, songs by hash, albums,
 * playlists (歌单 "special"), KRC lyrics. A song is several files, one hash per quality; the
 * play-info endpoint answers with a URL only for what the account may play.
 */

const MOBILE = { 'user-agent': MOBILE_UA, referer: 'http://m.kugou.com' };
const PC = { 'user-agent': PC_UA, referer: 'https://www.kugou.com/' };

function cookie(): Record<string, string> {
  const c = loadConfig().cookies.kugou;
  return c ? { cookie: c } : {};
}

interface Item {
  hash?: string;
  FileHash?: string;
  HQFileHash?: string;
  '320hash'?: string;
  SQFileHash?: string;
  sqhash?: string;
  FileSize?: number | string;
  filesize?: number;
  HQFileSize?: number;
  '320filesize'?: number;
  SQFileSize?: number;
  sqfilesize?: number;
  SongName?: string;
  songname?: string;
  SingerName?: string;
  singername?: string;
  AlbumName?: string;
  album_name?: string;
  AlbumID?: string;
  album_id?: string;
  Duration?: number;
  duration?: number;
  Image?: string;
  filename?: string;
  Privilege?: number;
  privilege?: number;
  trans_param?: { union_cover?: string };
}

function toTrack(i: Item): Track | undefined {
  const hash = first(i.FileHash, i.hash).toLowerCase();
  if (!hash) return undefined;
  // Playlist entries only have "歌手 - 歌名" in filename sometimes.
  const [fArtist, fName] = (i.filename ?? '').split(' - ');
  const title = cleanText(first(i.SongName, i.songname, fName, i.filename));
  const privilege = num(first(i.Privilege, i.privilege));
  return {
    id: hash,
    source: 'kugou',
    title,
    artists: splitArtists(first(i.SingerName, i.singername, fArtist)),
    album: cleanText(first(i.AlbumName, i.album_name)) || undefined,
    duration: num(first(i.Duration, i.duration)) || undefined,
    cover: (first(i.Image, i.trans_param?.union_cover) || undefined)?.replace('{size}', '480'),
    // 10 = members only (a member's own cookie may still play it)
    playable: privilege === 10 && !loadConfig().cookies.kugou ? false : undefined,
    extra: {
      hash128: hash,
      hash320: first(i.HQFileHash, i['320hash']).toLowerCase(),
      hashsq: first(i.SQFileHash, i.sqhash).toLowerCase(),
      size128: num(first(i.FileSize, i.filesize)),
      size320: num(first(i.HQFileSize, i['320filesize'])),
      sizesq: num(first(i.SQFileSize, i.sqfilesize)),
      albumId: first(i.AlbumID, i.album_id),
    },
  };
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const params = new URLSearchParams({
    keyword: query,
    platform: 'WebFilter',
    format: 'json',
    page: '1',
    pagesize: '20',
    userid: '-1',
    clientver: '',
    tag: 'em',
    filter: '2',
    iscorrection: '1',
    privilege_filter: '0',
    _: String(Date.now()),
  });
  const r = await getJson<{ data?: { lists?: Item[] } }>(`http://songsearch.kugou.com/song_search_v2?${params}`, {
    headers: { ...MOBILE, ...cookie() },
    signal,
  });
  return (r.data?.lists ?? []).map(toTrack).filter((t): t is Track => !!t);
}

interface PlayInfo {
  url?: string | string[];
  bitRate?: number;
  extName?: string;
  fileSize?: number;
  errcode?: number;
  songName?: string;
  author_name?: string;
  album_img?: string;
  timeLength?: number;
}

async function playInfo(hash: string, signal?: AbortSignal): Promise<PlayInfo | undefined> {
  const r = await getJson<PlayInfo>(`http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`, {
    headers: { ...MOBILE, ...cookie() },
    signal,
  }).catch(() => undefined);
  const url = Array.isArray(r?.url) ? r.url[0] : r?.url;
  return r && url && !r.errcode ? { ...r, url } : undefined;
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  const e = t.extra ?? {};
  const levels: { id: string; hash: string; label: string; size: number }[] = [
    { id: 'sq', hash: String(e.hashsq ?? ''), label: '无损 FLAC', size: num(e.sizesq) },
    { id: '320', hash: String(e.hash320 ?? ''), label: '320k MP3', size: num(e.size320) },
    { id: '128', hash: String(e.hash128 ?? t.id), label: '128k MP3', size: num(e.size128) },
  ].filter((l) => l.hash);
  const infos = await Promise.all(levels.map((l) => playInfo(l.hash, signal)));
  return levels.flatMap((l, i) => {
    const info = infos[i];
    const url = info?.url as string | undefined;
    if (!url) return [];
    const ext: Quality['ext'] = /flac/i.test(info!.extName ?? url) ? 'flac' : 'mp3';
    return [{ id: l.id, label: l.label, ext, size: info!.fileSize || l.size || undefined, url, kbps: info!.bitRate ? Math.round(info!.bitRate / 1000) : undefined }];
  });
}

/** KRC is zlib data XOR-ed with a fixed key behind a 4-byte header. */
const KRC_KEY = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]);
export function decodeKrc(b64: string): string {
  const raw = Buffer.from(b64, 'base64').subarray(4);
  const plain = Buffer.from(raw.map((b, i) => b ^ KRC_KEY[i % KRC_KEY.length]!));
  return inflateSync(plain).toString('utf8');
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const s = await getJson<{ candidates?: { id: string | number; accesskey: string }[] }>(
    `http://krcs.kugou.com/search?ver=1&client=mobi&duration=${(t.duration ?? 0) * 1000}&hash=${t.id}&album_audio_id=`,
    { headers: { ...MOBILE, ...cookie() }, signal },
  );
  const c = s.candidates?.[0];
  if (!c) return undefined;
  const d = await getJson<{ content?: string; fmt?: string; contenttype?: number }>(
    `http://lyrics.kugou.com/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`,
    { headers: { ...MOBILE, ...cookie() }, signal },
  );
  if (!d.content) return undefined;
  const text = d.contenttype === 2 || d.fmt === 'lrc' ? Buffer.from(d.content, 'base64').toString('utf8') : timedToLrc(decodeKrc(d.content));
  return text.trim() ? { lrc: text } : undefined;
}

async function album(id: string, signal?: AbortSignal): Promise<TrackList> {
  const info = await getJson<{ data?: { albumname?: string; singername?: string } }>(
    `http://mobilecdn.kugou.com/api/v3/album/info?albumid=${id}&version=9108&area_code=1`,
    { headers: { ...MOBILE, ...cookie() }, signal },
  ).catch(() => undefined);
  const tracks: Track[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await getJson<{ data?: { total?: number; info?: Item[] } }>(
      `http://mobilecdn.kugou.com/api/v3/album/song?albumid=${id}&page=${page}&pagesize=100&version=9108&area_code=1`,
      { headers: { ...MOBILE, ...cookie() }, signal },
    );
    const items = r.data?.info ?? [];
    tracks.push(...items.map(toTrack).filter((t): t is Track => !!t));
    if (items.length < 100 || tracks.length >= num(r.data?.total)) break;
  }
  if (!tracks.length) throw new FatalError('专辑不存在或没有可用的歌曲。');
  return { title: cleanText(info?.data?.albumname) || '酷狗专辑', kind: 'album', tracks };
}

async function playlist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const r = await getJson<{ data?: { info?: Item[] } }>(
    `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${id}&page=1&pagesize=300&version=9108&area_code=1`,
    { headers: { ...MOBILE, ...cookie() }, signal },
  );
  const tracks = (r.data?.info ?? []).map(toTrack).filter((t): t is Track => !!t);
  if (!tracks.length) throw new FatalError('歌单不存在或是私密歌单。');
  return { title: '酷狗歌单', kind: 'playlist', tracks };
}

async function song(hash: string, signal?: AbortSignal): Promise<TrackList> {
  const info = await playInfo(hash, signal);
  if (!info) throw new FatalError('歌曲不存在，或当前网络/账号不能播放。');
  const t: Track = {
    id: hash,
    source: 'kugou',
    title: cleanText(info.songName),
    artists: splitArtists(info.author_name),
    duration: info.timeLength || undefined,
    cover: info.album_img?.replace('{size}', '480'),
    extra: { hash128: hash },
  };
  return { title: t.title, kind: 'track', tracks: [t] };
}

export const kugou: MusicProvider = {
  source: 'kugou',
  name: '酷狗音乐',
  headers: PC,
  async list(input, signal) {
    // Share links (t1.kugou.com, m.kugou.com/share …) land on the song's page.
    const url = /^https?:\/\/(t\d*|m)\.kugou\.com\//.test(input) ? await followRedirects(input, { signal }) : input;
    const hash = url.match(/hash=([0-9a-f]{32})/i)?.[1];
    if (hash) return song(hash.toLowerCase(), signal);
    const albumId = url.match(/album\/(?:single\/)?(\d+)/)?.[1] ?? url.match(/albumid=(\d+)/i)?.[1];
    if (albumId) return album(albumId, signal);
    const special = url.match(/special\/single\/(\d+)/)?.[1] ?? url.match(/specialid=(\d+)/i)?.[1];
    if (special) return playlist(special, signal);
    // Song pages (/mixsong/<id>.html, /share/<chain>.html) carry the hash in their page data.
    if (/\/(mixsong|share|song)\b/.test(url)) {
      const page = await getText(url, { headers: PC, signal });
      const found = page.match(/"hash"\s*:\s*"([0-9a-fA-F]{32})"/)?.[1] ?? page.match(/hash=([0-9a-fA-F]{32})/)?.[1];
      if (found) return song(found.toLowerCase(), signal);
    }
    throw new FatalError('没有识别出酷狗的歌曲、专辑或歌单编号。');
  },
  search,
  qualities,
  lyrics,
};
