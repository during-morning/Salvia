import { FatalError, getJson } from '@salvia/core';
import type { Entry, Listing } from '@salvia/video';
import { BILI_HEADERS, biliClient } from './client.ts';

/**
 * Lists of videos on B站 beyond one video: an UP主's uploads (space.bilibili.com/<mid>), a 收藏夹
 * (favlist / ml…), and a space's 合集 (season) or 系列 (series).
 */

export type SpaceRef =
  | { kind: 'up'; mid: string }
  | { kind: 'fav'; id: string }
  | { kind: 'season' | 'series'; mid: string; id: string };

export function parseSpace(input: string): SpaceRef | undefined {
  const fav = input.match(/[?&]fid=(\d+)/)?.[1] ?? input.match(/\/(?:medialist\/detail|list|medialist\/play)\/ml(\d+)/)?.[1];
  if (fav) return { kind: 'fav', id: fav };
  const mid = input.match(/space\.bilibili\.com\/(\d+)/)?.[1];
  if (!mid) return undefined;
  const season = input.match(/collectiondetail\?sid=(\d+)/)?.[1] ?? input.match(/\/lists\/(\d+)\?type=season/)?.[1];
  if (season) return { kind: 'season', mid, id: season };
  const series = input.match(/seriesdetail\?sid=(\d+)/)?.[1] ?? input.match(/\/lists\/(\d+)\?type=series/)?.[1];
  if (series) return { kind: 'series', mid, id: series };
  return { kind: 'up', mid };
}

type Video = { bvid: string; title: string; duration?: number; uploader?: string };

/** At most this many pages of each list (a few hundred videos). */
const MAX_PAGES = 10;

/**
 * Fetch pages until `more` says stop. Pages are spaced out (B站 rate-limits rapid paging), and a
 * refused later page ends the list with what arrived instead of failing it.
 */
async function pages<T>(fetch: (pn: number) => Promise<{ items: T[]; more: boolean }>, max: number, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  for (let pn = 1; pn <= max; pn++) {
    if (pn > 1) await new Promise((r) => setTimeout(r, 400));
    if (signal?.aborted) break;
    let page;
    try {
      page = await fetch(pn);
    } catch (err) {
      if (pn === 1) throw err;
      break;
    }
    out.push(...page.items);
    if (!page.more || !page.items.length) break;
  }
  return out;
}

async function upVideos(mid: string, signal?: AbortSignal): Promise<{ title: string; videos: Video[] }> {
  // The space page's own search endpoint (wbi arc/search) is behind B站's anti-crawl check; this
  // public one lists the same uploads, newest first.
  let seen = 0;
  const videos = await pages<Video>(async (pn) => {
    const r = await getJson<{ code: number; data?: { archives?: { bvid: string; title: string; duration?: number }[]; page?: { total?: number } } }>(
      `https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${mid}&keywords=&ps=50&pn=${pn}`,
      { headers: { ...BILI_HEADERS, referer: `https://space.bilibili.com/${mid}` }, jar: biliClient().jar, signal },
    );
    if (r.code !== 0) throw new FatalError(`B站返回错误 ${r.code}`);
    const items = (r.data?.archives ?? []).map((v) => ({ bvid: v.bvid, title: v.title, duration: v.duration }));
    seen += items.length;
    return { items, more: seen < (r.data?.page?.total ?? 0) };
  }, MAX_PAGES, signal);
  const card = await getJson<{ data?: { card?: { name?: string } } }>(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, { headers: BILI_HEADERS, signal }).catch(() => undefined);
  const name = card?.data?.card?.name;
  return { title: `${name || `UP主 ${mid}`} 的投稿`, videos: videos.map((v) => ({ ...v, uploader: name })) };
}

async function favVideos(id: string, signal?: AbortSignal): Promise<{ title: string; videos: Video[] }> {
  let title = `收藏夹 ${id}`;
  const videos = await pages<Video>(async (pn) => {
    const r = await getJson<{
      code: number;
      message?: string;
      data?: { info?: { title?: string }; medias?: { bvid: string; title: string; duration?: number; upper?: { name?: string }; attr?: number }[]; has_more?: boolean };
    }>(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&ps=20&pn=${pn}&platform=web`, { headers: BILI_HEADERS, jar: biliClient().jar, signal });
    if (r.code !== 0) throw new FatalError(r.code === -403 ? '这个收藏夹是私密的：登录收藏夹的主人账号（@login bilibili）后可读取。' : `B站返回错误 ${r.code}：${r.message ?? ''}`);
    title = r.data?.info?.title ?? title;
    // attr 9 / 1: removed or invalid videos.
    const items = (r.data?.medias ?? []).filter((m) => m.bvid && !(m.attr && m.attr & 1)).map((m) => ({ bvid: m.bvid, title: m.title, duration: m.duration, uploader: m.upper?.name }));
    return { items, more: !!r.data?.has_more };
  }, MAX_PAGES * 2, signal);
  return { title, videos };
}

async function seasonVideos(ref: { kind: 'season' | 'series'; mid: string; id: string }, signal?: AbortSignal): Promise<{ title: string; videos: Video[] }> {
  let title = ref.kind === 'season' ? `合集 ${ref.id}` : `系列 ${ref.id}`;
  let seen = 0;
  const videos = await pages<Video>(async (pn) => {
    const url =
      ref.kind === 'season'
        ? `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${ref.mid}&season_id=${ref.id}&page_num=${pn}&page_size=100`
        : `https://api.bilibili.com/x/series/archives?mid=${ref.mid}&series_id=${ref.id}&pn=${pn}&ps=100`;
    const r = await getJson<{ code: number; data?: { archives?: { bvid: string; title: string; duration?: number }[]; meta?: { name?: string }; page?: { total?: number } } }>(url, {
      headers: BILI_HEADERS,
      jar: biliClient().jar,
      signal,
    });
    if (r.code !== 0) throw new FatalError(`B站返回错误 ${r.code}`);
    title = r.data?.meta?.name ?? title;
    const items = (r.data?.archives ?? []).map((a) => ({ bvid: a.bvid, title: a.title, duration: a.duration }));
    seen += items.length;
    return { items, more: seen < (r.data?.page?.total ?? 0) };
  }, MAX_PAGES, signal);
  return { title, videos };
}

/** The list as entries; each video resolves its own formats (via `one`) when opened or downloaded. */
export async function spaceListing(ref: SpaceRef, one: (bvid: string, signal?: AbortSignal) => Promise<Listing>, signal?: AbortSignal): Promise<Listing> {
  // Anonymous requests need the device cookies the site's pages set first.
  await biliClient().prepared(signal);
  const { title, videos } = ref.kind === 'up' ? await upVideos(ref.mid, signal) : ref.kind === 'fav' ? await favVideos(ref.id, signal) : await seasonVideos(ref, signal);
  if (!videos.length) throw new FatalError('这个列表是空的（或需要登录才能看到）。');
  const entries = videos.map<Entry>((v) => ({
    id: v.bvid,
    title: v.title,
    duration: v.duration,
    async resolve(s) {
      const l = await one(v.bvid, s);
      return l.entries[l.current]!.resolve(s);
    },
  }));
  return { title, uploader: videos[0]?.uploader, entries, current: 0 };
}
