import { FatalError, getJson, getText, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track, TrackList } from '@salvia/music';
import { PC_UA, cleanText, md5, num } from '@salvia/music';

/**
 * 千千音乐 (music.91q.com; protocol as in guohuiyuan/music-lib, reimplemented). Every request is
 * signed: md5 of the sorted query plus the web app's secret. Search, songs, albums, playlists,
 * lyrics. A "trail" (trial) link is a preview, never offered as the download.
 */

const APP_ID = '16073360';
const SECRET = '0b50b02fd0d73a9c4c8c3a781c30845f';
const HEADERS = { 'user-agent': PC_UA, referer: 'https://music.91q.com/player' };

function auth(): Record<string, string> {
  const c = loadConfig().cookies.qianqian;
  return c ? { cookie: c } : {};
}

/** Adds timestamp and sign the way the web player does. */
export function signed(params: Record<string, string>, now = Date.now()): URLSearchParams {
  const all: Record<string, string> = { ...params, appid: APP_ID, timestamp: String(Math.floor(now / 1000)) };
  const base = Object.keys(all)
    .sort()
    .map((k) => `${k}=${all[k]}`)
    .join('&');
  return new URLSearchParams({ ...all, sign: md5(base + SECRET) });
}

const api = <T>(path: string, params: Record<string, string>, signal?: AbortSignal) =>
  getJson<T>(`https://music.91q.com/v1/${path}?${signed(params)}`, { headers: { ...HEADERS, ...auth() }, signal });

interface Item {
  TSID?: string;
  assetId?: string;
  title?: string;
  albumTitle?: string;
  albumAssetCode?: string;
  pic?: string;
  duration?: number;
  artist?: { name?: string }[];
  isVip?: number;
}

function toTrack(i: Item, album?: string): Track | undefined {
  const id = i.TSID ?? i.assetId;
  if (!id) return undefined;
  return {
    id,
    source: 'qianqian',
    title: cleanText(i.title),
    artists: (i.artist ?? []).map((a) => cleanText(a.name)).filter(Boolean),
    album: cleanText(i.albumTitle ?? album) || undefined,
    duration: num(i.duration) || undefined,
    cover: i.pic || undefined,
    playable: i.isVip && !loadConfig().cookies.qianqian ? false : undefined,
    extra: { albumId: i.albumAssetCode ?? '' },
  };
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const r = await api<{ data?: { typeTrack?: Item[] } }>('search', { word: query, type: '1', pageNo: '1', pageSize: '20' }, signal);
  return (r.data?.typeTrack ?? []).map((i) => toTrack(i)).filter((t): t is Track => !!t);
}

const RATES: { rate: string; label: string; ext: Quality['ext']; kbps: number }[] = [
  { rate: '3000', label: '无损 FLAC', ext: 'flac', kbps: 1411 },
  { rate: '320', label: '320k MP3', ext: 'mp3', kbps: 320 },
  { rate: '128', label: '128k MP3', ext: 'mp3', kbps: 128 },
];

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  const answers = await Promise.all(
    RATES.map((r) =>
      api<{ data?: { path?: string; format?: string; size?: number; rate?: number; trail_audio_info?: { path?: string } } }>('song/tracklink', { TSID: t.id, rate: r.rate }, signal).catch(
        () => undefined,
      ),
    ),
  );
  const seen = new Set<string>();
  return RATES.flatMap((r, i) => {
    const d = answers[i]?.data;
    const url = d?.path || d?.trail_audio_info?.path;
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const ext: Quality['ext'] = /flac/i.test(d?.format ?? url) ? 'flac' : 'mp3';
    return [{ id: r.rate, label: d?.path ? r.label : `${r.label}（试听）`, ext, kbps: num(d?.rate) || r.kbps, size: num(d?.size) || undefined, url, trial: !d?.path }];
  });
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const r = await api<{ data?: { lyric?: string }[] }>('song/info', { TSID: t.id }, signal);
  const url = r.data?.[0]?.lyric;
  if (!url) return undefined;
  const lrc = await getText(url, { headers: HEADERS, signal });
  return lrc.trim() ? { lrc } : undefined;
}

async function album(code: string, signal?: AbortSignal): Promise<TrackList> {
  const r = await api<{ data?: { title?: string; pic?: string; trackList?: Item[] } }>('album/info', { albumAssetCode: code }, signal);
  const tracks = (r.data?.trackList ?? []).map((i) => toTrack({ ...i, pic: i.pic ?? r.data?.pic }, r.data?.title)).filter((t): t is Track => !!t);
  if (!tracks.length) throw new FatalError('专辑不存在。');
  return { title: cleanText(r.data?.title) || '千千专辑', kind: 'album', tracks };
}

async function playlist(id: string, signal?: AbortSignal): Promise<TrackList> {
  const r = await api<{ data?: { title?: string; trackList?: Item[] } }>('tracklist/info', { id, type: '0' }, signal);
  const tracks = (r.data?.trackList ?? []).map((i) => toTrack(i)).filter((t): t is Track => !!t);
  if (!tracks.length) throw new FatalError('歌单不存在。');
  return { title: cleanText(r.data?.title) || '千千歌单', kind: 'playlist', tracks };
}

export const qianqian: MusicProvider = {
  source: 'qianqian',
  name: '千千音乐',
  headers: HEADERS,
  async list(url, signal) {
    const song = url.match(/\/song\/(T\d+)/i)?.[1] ?? url.match(/[?&](?:id|tsid)=(T\d+)/i)?.[1];
    if (song) {
      const r = await api<{ data?: Item[] }>('song/info', { TSID: song }, signal);
      const t = r.data?.[0] ? toTrack(r.data[0]) : undefined;
      if (!t) throw new FatalError('歌曲不存在。');
      return { title: t.title, kind: 'track', tracks: [t] };
    }
    const albumCode = url.match(/\/album\/(P\d+)/i)?.[1];
    if (albumCode) return album(albumCode, signal);
    const list = url.match(/\/songlist\/(\d+)/)?.[1];
    if (list) return playlist(list, signal);
    throw new FatalError('没有识别出千千音乐的歌曲、专辑或歌单编号。');
  },
  search,
  qualities,
  lyrics,
};
