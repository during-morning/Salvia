import { FatalError, followRedirects, getJson, getText, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { MOBILE_UA, cleanText, first, num } from '@salvia/music';

/**
 * 咪咕音乐 (protocol as in guohuiyuan/music-lib, reimplemented). Search, songs, albums, playlists,
 * lyrics. The listen-url endpoint decides what the account may play; encrypted "3D" streams
 * (which need decrypting) are left out.
 */

const HEADERS = { 'user-agent': MOBILE_UA, referer: 'http://music.migu.cn/' };
const LISTEN = { 'user-agent': 'Android_migu/7.41.13 okhttp/3.12.13', channel: '0146832', version: '7.41.13', referer: 'https://music.migu.cn/' };

function auth(): Record<string, string> {
  const c = loadConfig().cookies.migu;
  return c ? { cookie: c } : {};
}

interface Format {
  formatType?: string;
  resourceType?: string;
  size?: string;
  androidSize?: string;
  asize?: string;
  isize?: string;
  price?: string;
  showTag?: string[];
}

interface Item {
  id?: string;
  name?: string;
  songName?: string;
  songId?: string;
  contentId?: string;
  copyrightId?: string;
  albumId?: string;
  album?: string;
  albums?: { id?: string; name?: string }[];
  singer?: string;
  singers?: { name?: string }[];
  singerList?: { name?: string }[];
  artists?: { name?: string }[];
  imgItems?: { img?: string; imgSizeType?: string }[];
  albumImgs?: { img?: string; imgSizeType?: string }[];
  img1?: string;
  newRateFormats?: Format[];
  rateFormats?: Format[];
  audioFormats?: Format[];
  duration?: number;
  chargeAuditions?: string;
}

/** Plain formats only; 3D/Z3D/I3D are encrypted. */
const TONES: Record<string, { label: string; ext: Quality['ext']; kbps: number; rank: number }> = {
  ZQ: { label: 'Hi-Res FLAC', ext: 'flac', kbps: 2304, rank: 4 },
  ZQ24: { label: 'Hi-Res FLAC', ext: 'flac', kbps: 2304, rank: 4 },
  SQ: { label: '无损 FLAC', ext: 'flac', kbps: 1411, rank: 3 },
  HQ: { label: '320k MP3', ext: 'mp3', kbps: 320, rank: 2 },
  PQ: { label: '128k MP3', ext: 'mp3', kbps: 128, rank: 1 },
};

function image(i: Item): string | undefined {
  const imgs = [...(i.imgItems ?? []), ...(i.albumImgs ?? [])];
  const pick = ['02', '01', '03'].map((t) => imgs.find((x) => x.imgSizeType === t && x.img)).find(Boolean)?.img ?? imgs.find((x) => x.img)?.img ?? i.img1;
  if (!pick) return undefined;
  return pick.startsWith('//') ? `https:${pick}` : pick.startsWith('/') ? `https://d.musicapp.migu.cn${pick}` : pick;
}

function toTrack(i: Item): Track | undefined {
  const contentId = first(i.contentId);
  if (!contentId) return undefined;
  const formats = [...(i.newRateFormats ?? []), ...(i.rateFormats ?? []), ...(i.audioFormats ?? [])];
  const tones = [...new Set(formats.map((f) => (f.formatType ?? '').toUpperCase()).filter((t) => TONES[t]))];
  const sizes = Object.fromEntries(formats.map((f) => [(f.formatType ?? '').toUpperCase(), num(first(f.androidSize, f.asize, f.size, f.isize))]));
  const vip = formats.some((f) => f.showTag?.some((t) => /vip/i.test(t))) && formats.every((f) => (f.formatType ?? '') !== 'PQ' || f.showTag?.some((t) => /vip/i.test(t)));
  const artists = [...(i.singers ?? []), ...(i.singerList ?? []), ...(i.artists ?? [])].map((a) => cleanText(a.name)).filter(Boolean);
  return {
    id: contentId,
    source: 'migu',
    title: cleanText(first(i.name, i.songName)),
    artists: artists.length ? [...new Set(artists)] : (i.singer ?? '').split('|').filter(Boolean),
    album: cleanText(first(i.albums?.[0]?.name, i.album)) || undefined,
    duration: num(i.duration) || undefined,
    cover: image(i),
    playable: vip && !loadConfig().cookies.migu ? false : undefined,
    extra: {
      copyrightId: first(i.copyrightId),
      songId: first(i.songId, i.id),
      albumId: first(i.albums?.[0]?.id, i.albumId),
      resourceType: first(formats[0]?.resourceType, '2'),
      tones: tones.join(','),
      sizes: JSON.stringify(sizes),
    },
  };
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const params = new URLSearchParams({
    ua: 'Android_migu',
    version: '5.0.1',
    text: query,
    pageNo: '1',
    pageSize: '20',
    searchSwitch: '{"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}',
  });
  const r = await getJson<{ songResultData?: { result?: Item[] } }>(`http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?${params}`, { headers: { ...HEADERS, ...auth() }, signal });
  return (r.songResultData?.result ?? []).map(toTrack).filter((t): t is Track => !!t);
}

function normalizeUrl(u: string): string {
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('ftp://218.200.160.122:21/')) return `https://freetyst.nf.migu.cn/${u.slice('ftp://218.200.160.122:21/'.length)}`;
  return u;
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  const e = t.extra ?? {};
  const listed = String(e.tones ?? '').split(',').filter(Boolean);
  const tones = (listed.length ? listed : ['SQ', 'HQ', 'PQ']).sort((a, b) => TONES[b]!.rank - TONES[a]!.rank);
  const sizes = e.sizes ? (JSON.parse(String(e.sizes)) as Record<string, number>) : {};
  const answers = await Promise.all(
    tones.map((tone) => {
      const params = new URLSearchParams({ netType: '01', resourceType: String(e.resourceType || '2'), contentId: t.id, toneFlag: tone });
      if (e.copyrightId) params.set('copyrightId', String(e.copyrightId));
      if (e.songId) params.set('songId', String(e.songId));
      if (e.albumId) params.set('albumId', String(e.albumId));
      return getJson<{ code?: string; data?: { url?: string; formatType?: string } }>(`https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url?${params}`, {
        headers: { ...LISTEN, ...auth() },
        signal,
      }).catch(() => undefined);
    }),
  );
  const seen = new Set<string>();
  return tones.flatMap((tone, i) => {
    const d = answers[i]?.data;
    if (!d?.url) return [];
    const url = normalizeUrl(d.url);
    // wav_3d paths are the encrypted 3D streams.
    if (seen.has(url) || /wav_3d\//.test(decodeURIComponent(url))) return [];
    seen.add(url);
    const actual = TONES[(d.formatType ?? tone).toUpperCase()] ?? TONES[tone]!;
    return [{ id: tone, label: actual.label, ext: actual.ext, kbps: actual.kbps, size: sizes[tone] || undefined, url }];
  });
}

async function resource(contentId: string, signal?: AbortSignal): Promise<(Item & { lrcUrl?: string; lyricUrl?: string }) | undefined> {
  const r = await getJson<{ resource?: (Item & { lrcUrl?: string; lyricUrl?: string })[] }>(
    `http://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2&resourceId=${contentId}`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  return r.resource?.[0];
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const r = await resource(t.id, signal);
  const url = first(r?.lrcUrl, r?.lyricUrl).replace(/^http:/, 'https:');
  if (!url) return undefined;
  const lrc = await getText(url, { headers: { referer: 'https://y.migu.cn/' }, signal });
  return lrc.trim() ? { lrc } : undefined;
}

async function pagedSongs(base: string, label: string, signal?: AbortSignal): Promise<Track[]> {
  const tracks: Track[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await getJson<{ data?: { songList?: Item[]; totalCount?: number } }>(`${base}&pageNo=${page}&pageSize=50`, { headers: { ...HEADERS, ...auth() }, signal });
    const items = r.data?.songList ?? [];
    tracks.push(...items.map(toTrack).filter((t): t is Track => !!t));
    if (items.length < 50 || tracks.length >= num(r.data?.totalCount)) break;
  }
  if (!tracks.length) throw new FatalError(`${label}不存在或没有可用的歌曲。`);
  return tracks;
}

export const migu: MusicProvider = {
  source: 'migu',
  name: '咪咕音乐',
  headers: HEADERS,
  async list(url, signal) {
    if (/^https?:\/\/c\.migu\.cn\//.test(url)) url = await followRedirects(url, { signal });
    const songId = url.match(/\/song\/(\d+)/)?.[1] ?? url.match(/[?&](?:copyrightId|songId|contentId|id)=(\d+)/)?.[1];
    if (songId) {
      const r = await resource(songId, signal);
      const t = r ? toTrack({ ...r, contentId: r.contentId ?? songId }) : undefined;
      if (!t) throw new FatalError('歌曲不存在。');
      return { title: t.title, kind: 'track', tracks: [t] } satisfies TrackList;
    }
    const albumId = url.match(/\/album\/(\d+)/)?.[1];
    if (albumId) {
      const tracks = await pagedSongs(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/queryAlbumSong?albumId=${albumId}`, '专辑', signal);
      return { title: tracks[0]?.album ?? '咪咕专辑', kind: 'album', tracks };
    }
    const playlistId = url.match(/playlistId=(\d+)/)?.[1] ?? url.match(/\/playlist\/(\d+)/)?.[1];
    if (playlistId) {
      const tracks = await pagedSongs(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?playlistId=${playlistId}`, '歌单', signal);
      return { title: '咪咕歌单', kind: 'playlist', tracks };
    }
    throw new FatalError('没有识别出咪咕的歌曲、专辑或歌单编号。');
  },
  search,
  qualities,
  lyrics,
};
