import { FatalError, HttpError, getJson, getText, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track } from '@salvia/music';
import { PC_UA, cleanText, num, unwrapJsonp } from '@salvia/music';

/**
 * JOOX (Tencent's music service for Hong Kong and Southeast Asia; protocol as in
 * guohuiyuan/music-lib, reimplemented). Search, song links, the files the region allows, lyrics.
 * music-lib sends a fixed Indonesian X-Forwarded-For to get past the region check; Salvia
 * doesn't fake its address — use a JOOX-region network (@proxy) where it is blocked.
 */

const HEADERS = { 'user-agent': PC_UA, referer: 'https://www.joox.com/' };

function auth(): Record<string, string> {
  const c = loadConfig().cookies.joox;
  return c ? { cookie: c } : {};
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  type Info = { id?: string; name?: string; album_name?: string; artist_list?: { name?: string }[]; play_duration?: number; images?: { width?: number; url?: string }[]; vip_flag?: number };
  const r = await getJson<{ section_list?: { item_list?: { song?: { song_info?: Info }[] }[] }[] }>(
    `https://cache.api.joox.com/openjoox/v3/search?country=sg&lang=zh_cn&keyword=${encodeURIComponent(query)}`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  const out: Track[] = [];
  for (const section of r.section_list ?? []) {
    for (const item of section.item_list ?? []) {
      for (const s of item.song ?? []) {
        const i = s.song_info;
        if (!i?.id || out.some((t) => t.id === i.id)) continue;
        out.push({
          id: i.id,
          source: 'joox',
          title: cleanText(i.name),
          artists: (i.artist_list ?? []).map((a) => cleanText(a.name)).filter(Boolean),
          album: cleanText(i.album_name) || undefined,
          duration: num(i.play_duration) || undefined,
          cover: (i.images ?? []).find((x) => x.width === 300)?.url ?? i.images?.[0]?.url,
          playable: i.vip_flag && !loadConfig().cookies.joox ? false : undefined,
        });
      }
    }
  }
  return out;
}

interface SongInfo {
  msong?: string;
  msinger?: string;
  malbum?: string;
  img?: string;
  minterval?: number;
  r320Url?: string;
  r192Url?: string;
  mp3Url?: string;
  m4aUrl?: string;
  kbps_map?: string | Record<string, number | string>;
}

async function songInfo(id: string, signal?: AbortSignal): Promise<SongInfo> {
  const text = await getText(`https://api.joox.com/web-fcgi-bin/web_get_songinfo?songid=${encodeURIComponent(id)}&lang=zh_cn&country=sg`, { headers: { ...HEADERS, ...auth() }, signal });
  return unwrapJsonp<SongInfo>(text);
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  // Outside JOOX's regions the endpoint answers 404: nothing to offer then.
  const s = await songInfo(t.id, signal).catch((err) => {
    if (err instanceof HttpError && err.status === 404) return {} as SongInfo;
    throw err;
  });
  const map = typeof s.kbps_map === 'string' ? (JSON.parse(s.kbps_map || '{}') as Record<string, number>) : (s.kbps_map ?? {});
  const levels: { kbps: number; url?: string; ext: Quality['ext']; label: string }[] = [
    { kbps: 320, url: s.r320Url, ext: 'mp3', label: '320k MP3' },
    { kbps: 192, url: s.r192Url, ext: 'ogg', label: '192k OGG' },
    { kbps: 128, url: s.mp3Url, ext: 'mp3', label: '128k MP3' },
    { kbps: 96, url: s.m4aUrl, ext: 'm4a', label: '96k AAC' },
  ];
  return levels
    .filter((l) => l.url && num(map[String(l.kbps)]) > 0)
    .map((l) => ({ id: String(l.kbps), label: l.label, ext: /\.m4a/.test(l.url!) ? 'm4a' : /\.ogg/.test(l.url!) ? 'ogg' : l.ext, kbps: l.kbps, size: num(map[String(l.kbps)]) || undefined, url: l.url! }));
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const text = await getText(`https://api.joox.com/web-fcgi-bin/web_lyric?musicid=${encodeURIComponent(t.id)}&country=sg&lang=zh_cn`, { headers: { ...HEADERS, ...auth() }, signal });
  const r = unwrapJsonp<{ lyric?: string }>(text);
  const lrc = r.lyric ? Buffer.from(r.lyric, 'base64').toString('utf8').trim() : '';
  return lrc ? { lrc } : undefined;
}

export const joox: MusicProvider = {
  source: 'joox',
  name: 'JOOX',
  headers: HEADERS,
  async list(url, signal) {
    const id = url.match(/\/single\/([\w+=-]+)/)?.[1];
    if (!id) throw new FatalError('没有识别出 JOOX 歌曲编号（形如 joox.com/hk/single/xxxx）。');
    const s = await songInfo(id, signal);
    if (!s.msong) throw new FatalError('歌曲不存在，或当前网络不在 JOOX 的服务地区。');
    const t: Track = { id, source: 'joox', title: cleanText(s.msong), artists: [cleanText(s.msinger)].filter(Boolean), album: cleanText(s.malbum) || undefined, cover: s.img, duration: num(s.minterval) || undefined };
    return { title: t.title, kind: 'track', tracks: [t] };
  },
  search,
  qualities,
  lyrics,
};
