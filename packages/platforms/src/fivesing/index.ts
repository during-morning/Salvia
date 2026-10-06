import { FatalError, getJson, loadConfig } from '@salvia/core';
import type { Lyrics, MusicProvider, Quality, Track } from '@salvia/music';
import { PC_UA, cleanText, num } from '@salvia/music';

/**
 * 5sing 原创/翻唱 (protocol as in guohuiyuan/music-lib, reimplemented). A song is "type + id"
 * (yc 原创 / fc 翻唱 / bz 伴奏). Search, song links, the files the site offers, lyrics.
 */

const HEADERS = { 'user-agent': PC_UA, referer: 'http://5sing.kugou.com/' };

function auth(): Record<string, string> {
  const c = loadConfig().cookies.fivesing;
  return c ? { cookie: c } : {};
}

const split = (t: Track) => {
  const [id, type] = t.id.split('|');
  return { id: id!, type: type || 'yc' };
};

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const r = await getJson<{ list?: { songId: number; songName: string; singer: string; songSize?: number; typeEname: string; typeName?: string }[] }>(
    `http://search.5sing.kugou.com/home/json?keyword=${encodeURIComponent(query)}&sort=1&page=1&filter=0&type=0`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  return (r.list ?? []).map((i) => ({
    id: `${i.songId}|${i.typeEname}`,
    source: 'fivesing' as const,
    title: cleanText(i.songName),
    artists: [cleanText(i.singer)].filter(Boolean),
    album: i.typeName ? `5sing ${i.typeName}` : undefined,
    // Only the file size is known; 5sing files are mostly 320k mp3.
    duration: i.songSize ? Math.round((i.songSize * 8) / 320000) : undefined,
  }));
}

async function info(t: Track, signal?: AbortSignal) {
  const { id, type } = split(t);
  return getJson<{ data?: { SN?: string; dynamicWords?: string; user?: { NN?: string; I?: string } } }>(
    `http://mobileapi.5sing.kugou.com/song/newget?songid=${id}&songtype=${type}`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  const { id, type } = split(t);
  const r = await getJson<{ code?: number; data?: Record<string, string | number> }>(
    `http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=${id}&songtype=${type}`,
    { headers: { ...HEADERS, ...auth() }, signal },
  );
  if (r.code !== 1000 || !r.data) return [];
  const d = r.data;
  const levels: { key: string; label: string; kbps: number }[] = [
    { key: 'sq', label: '无损', kbps: 1000 },
    { key: 'hq', label: '320k', kbps: 320 },
    { key: 'lq', label: '128k', kbps: 128 },
  ];
  return levels.flatMap((l) => {
    const url = String(d[`${l.key}url`] || d[`${l.key}url_backup`] || '');
    if (!url) return [];
    const ext: Quality['ext'] = /\.flac/i.test(url) ? 'flac' : /\.m4a/i.test(url) ? 'm4a' : 'mp3';
    return [{ id: l.key, label: `${l.label} ${ext.toUpperCase()}`, ext, kbps: l.kbps, size: num(d[`${l.key}size`]) || undefined, url }];
  });
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const words = (await info(t, signal)).data?.dynamicWords?.trim();
  return words ? { lrc: words } : undefined;
}

export const fivesing: MusicProvider = {
  source: 'fivesing',
  name: '5sing',
  headers: HEADERS,
  async list(url, signal) {
    const m =
      url.match(/5sing\.kugou\.com\/(yc|fc|bz)\/(\d+)\.html/) ??
      url.match(/\/m\/detail\/(yc|fc|bz)-(\d+)/) ??
      (() => {
        const q = new URL(url).searchParams;
        const id = q.get('songid') ?? q.get('songId');
        const type = q.get('songtype') ?? q.get('songType') ?? 'yc';
        return id ? ([, type, id] as unknown as RegExpMatchArray) : null;
      })();
    if (!m) throw new FatalError('没有识别出 5sing 歌曲编号（形如 5sing.kugou.com/yc/123.html）。');
    const stub: Track = { id: `${m[2]}|${m[1]}`, source: 'fivesing', title: '', artists: [] };
    const d = (await info(stub, signal)).data;
    if (!d?.SN) throw new FatalError('歌曲不存在。');
    const t: Track = { ...stub, title: cleanText(d.SN), artists: [cleanText(d.user?.NN)].filter(Boolean), cover: d.user?.I };
    return { title: t.title, kind: 'track', tracks: [t] };
  },
  search,
  qualities,
  lyrics,
};
