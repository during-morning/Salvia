import { FatalError, captureRequests, getText, request } from '@salvia/core';

/**
 * 抖音 (approach after jiji262/douyin-downloader, MIT; reimplemented): videos and image posts
 * without the watermark, their background music, and a creator's latest posts.
 *
 * The data is what douyin.com's own page loads (`aweme/detail`, `aweme/post`), read from a hidden
 * window of Salvia's browser profile — so its request signing is the site's own. Douyin asks
 * anonymous visitors to verify; Salvia doesn't get around that: after `@login douyin` (where the
 * user signs in and completes any check themselves) the same profile is used.
 */

export const DOUYIN_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  referer: 'https://www.douyin.com/',
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface UrlList {
  uri?: string;
  url_list?: string[];
  width?: number;
  height?: number;
  data_size?: number;
}

export interface Aweme {
  aweme_id: string;
  desc?: string;
  create_time?: number;
  author?: { nickname?: string; sec_uid?: string };
  video?: {
    play_addr?: UrlList;
    duration?: number;
    cover?: UrlList;
    bit_rate?: { gear_name?: string; bit_rate?: number; play_addr?: UrlList; is_h265?: number; format?: string }[];
  };
  images?: (UrlList & { download_url_list?: string[] })[] | null;
  music?: { title?: string; author?: string; play_url?: UrlList };
  statistics?: { digg_count?: number; comment_count?: number; share_count?: number; collect_count?: number };
}

export type DouyinRef = { kind: 'post'; id: string } | { kind: 'user'; secUid: string };

/** Post ids and creator links, after following v.douyin.com short links. */
export async function parseDouyin(input: string, signal?: AbortSignal): Promise<DouyinRef> {
  let url = input.match(/https?:\/\/[^\s"'<>，。】]+/)?.[0] ?? input;
  if (/v\.douyin\.com\//.test(url)) {
    const res = await request(url, { headers: { 'user-agent': MOBILE_UA }, redirect: 'manual', signal, retries: 1 });
    await res.body?.cancel();
    url = res.headers.get('location') ?? url;
  }
  const id = url.match(/(?:video|note|slides)\/(\d{8,})/)?.[1] ?? url.match(/[?&](?:modal_id|vid|aweme_id)=(\d{8,})/)?.[1];
  if (id) return { kind: 'post', id };
  const user = url.match(/user\/([\w-]{20,})/)?.[1];
  if (user) return { kind: 'user', secUid: user };
  throw new FatalError('没有识别出抖音作品或主页链接（v.douyin.com 分享链接、douyin.com/video/…、douyin.com/user/…）。');
}

const NEED_LOGIN = '抖音要求验证后才给出作品数据。先用 @login douyin 在浏览器里登录（需要验证时请自己完成），再试一次。';

/** The share page sometimes carries the post in its server-rendered data (cheap, no browser). */
async function fromSharePage(id: string, signal?: AbortSignal): Promise<Aweme | undefined> {
  try {
    const html = await getText(`https://www.iesdouyin.com/share/video/${id}/`, { headers: { 'user-agent': MOBILE_UA }, signal, retries: 0, timeout: 10_000 });
    const json = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})<\/script>/)?.[1];
    if (!json) return undefined;
    const pages = Object.values(JSON.parse(json).loaderData ?? {}) as { videoInfoRes?: { item_list?: Aweme[] } }[];
    return pages.find((p) => p?.videoInfoRes)?.videoInfoRes?.item_list?.[0];
  } catch {
    return undefined;
  }
}

function parseBody<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

export async function douyinPost(id: string, signal?: AbortSignal): Promise<Aweme> {
  const ssr = await fromSharePage(id, signal);
  if (ssr) return ssr;
  const got = await captureRequests(`https://www.douyin.com/video/${id}`, /\/aweme\/v1\/web\/aweme\/detail\//, {
    signal,
    done: (g) => g.some((r) => parseBody<{ aweme_detail?: Aweme }>(r.body)?.aweme_detail),
    settleMs: 3000,
    maxMs: 30_000,
  });
  for (const r of got) {
    const detail = parseBody<{ aweme_detail?: Aweme; status_code?: number; filter_detail?: { notice?: string } }>(r.body);
    if (detail?.aweme_detail) return detail.aweme_detail;
    if (detail?.filter_detail?.notice) throw new FatalError(`抖音：${detail.filter_detail.notice}`);
  }
  throw new FatalError(NEED_LOGIN);
}

/** A creator's latest posts (the first page the profile shows). */
export async function douyinUserPosts(secUid: string, signal?: AbortSignal): Promise<{ name: string; posts: Aweme[] }> {
  const got = await captureRequests(`https://www.douyin.com/user/${secUid}`, /\/aweme\/v1\/web\/aweme\/post\//, {
    signal,
    done: (g) => g.some((r) => (parseBody<{ aweme_list?: Aweme[] }>(r.body)?.aweme_list?.length ?? 0) > 0),
    settleMs: 3000,
    maxMs: 30_000,
  });
  const posts = got.flatMap((r) => parseBody<{ aweme_list?: Aweme[] }>(r.body)?.aweme_list ?? []);
  if (!posts.length) throw new FatalError(NEED_LOGIN);
  const seen = new Set<string>();
  const unique = posts.filter((p) => !seen.has(p.aweme_id) && seen.add(p.aweme_id));
  return { name: unique[0]?.author?.nickname ?? '抖音用户', posts: unique };
}

export interface DouyinFile {
  id: string;
  label: string;
  url: string;
  mirrors: string[];
  ext: 'mp4' | 'mp3' | 'jpeg' | 'webp';
  size?: number;
}

/** No-watermark addresses: `play` instead of `playwm`. */
const clean = (u: string) => u.replace('/playwm/', '/play/');

/** The video at each quality (best first), or the post's images; plus the background music. */
export function filesOf(a: Aweme): { video: DouyinFile[]; images: DouyinFile[]; music?: DouyinFile } {
  const video: DouyinFile[] = [];
  const rates = [...(a.video?.bit_rate ?? [])].filter((b) => b.play_addr?.url_list?.length).sort((x, y) => (y.play_addr?.height ?? 0) - (x.play_addr?.height ?? 0) || (y.bit_rate ?? 0) - (x.bit_rate ?? 0));
  const seen = new Set<number>();
  for (const b of rates) {
    const h = b.play_addr!.height ?? 0;
    if (seen.has(h)) continue;
    seen.add(h);
    const [url, ...mirrors] = b.play_addr!.url_list!.map(clean);
    video.push({ id: `v${h}`, label: `${h ? `${Math.min(h, b.play_addr!.width ?? h)}p` : '原画'} · mp4${b.is_h265 ? ' · H.265' : ''}`, url: url!, mirrors, ext: 'mp4', size: b.play_addr!.data_size });
  }
  const plain = a.video?.play_addr?.url_list;
  if (!video.length && plain?.length && !a.images?.length) {
    const [url, ...mirrors] = plain.map(clean);
    video.push({ id: 'v', label: '视频 · mp4', url: url!, mirrors, ext: 'mp4' });
  }
  const images = (a.images ?? []).map((img, i) => {
    const list = img.download_url_list?.length ? img.download_url_list : (img.url_list ?? []);
    // Prefer a jpeg rendition when the site offers one.
    const ordered = [...list].sort((x, y) => Number(/jpe?g/.test(y)) - Number(/jpe?g/.test(x)));
    const [url = '', ...mirrors] = ordered;
    return { id: `img${i}`, label: `第 ${i + 1} 张`, url, mirrors, ext: /webp/.test(url) && !/jpe?g/.test(url) ? ('webp' as const) : ('jpeg' as const) };
  });
  const m = a.music?.play_url?.url_list?.[0];
  const music = m ? { id: 'music', label: `背景音乐 · ${[a.music?.title, a.music?.author].filter(Boolean).join(' - ') || 'mp3'}`, url: m, mirrors: [], ext: 'mp3' as const } : undefined;
  return { video, images: images.filter((i) => i.url), music };
}
