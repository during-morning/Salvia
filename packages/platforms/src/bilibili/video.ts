import { FatalError, request } from '@salvia/core';
import type { Entry, Format, Listing, Resolved, Stream } from '@salvia/video';
import { BILI_HEADERS, biliClient } from './client.ts';
import { bangumiListing, parseBangumi } from './pgc.ts';
import { parseSpace, spaceListing } from './space.ts';

export interface BiliRef {
  bvid?: string;
  aid?: number;
  /** 1-based page from ?p= */
  page?: number;
}

/** Parse BV/av ids, video URLs and b23.tv short links. */
export async function parseBili(input: string, signal?: AbortSignal): Promise<BiliRef> {
  let text = input.trim();
  if (/^https?:\/\/(b23\.tv|bili2233\.cn)\//i.test(text)) {
    const res = await request(text, { redirect: 'manual', signal, retries: 1 });
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!loc) throw new FatalError('短链接无法解析。');
    text = loc;
  }
  const bv = text.match(/BV[0-9A-Za-z]{10}/);
  const av = text.match(/\bav(\d+)/i);
  const p = text.match(/[?&]p=(\d+)/);
  const page = p ? Number(p[1]) : undefined;
  if (bv) return { bvid: bv[0], page };
  if (av?.[1]) return { aid: Number(av[1]), page };
  if (/bilibili\.com\/cheese\//.test(text)) throw new FatalError('课程暂不支持。');
  throw new FatalError('没有识别出 B站视频编号。');
}

export interface BiliSearchResult {
  id: string;
  title: string;
  channel: string;
  /** seconds */
  duration?: number;
  /** Why it can't be downloaded as is: 充电专属 (needs a paid UP主 subscription), 付费. */
  locked?: string;
}

/** Video search (web API, wbi-signed). */
export async function bilibiliSearch(keyword: string, signal?: AbortSignal): Promise<BiliSearchResult[]> {
  const res = await biliClient().api<{ result?: { type: string; bvid: string; title: string; author: string; duration: string; is_pay?: number; is_charge_video?: number }[] }>(
    'https://api.bilibili.com/x/web-interface/wbi/search/type',
    { search_type: 'video', keyword, page: 1 },
    signal,
  );
  const clock = (s: string) => s.split(':').reduce((a, p) => a * 60 + Number(p), 0) || undefined;
  return (res.result ?? [])
    .filter((r) => r.type === 'video' && r.bvid)
    .map((r) => ({
      id: r.bvid,
      title: r.title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      channel: r.author,
      duration: clock(r.duration),
      locked: r.is_charge_video ? '充电专属，需要给 UP主充电' : r.is_pay ? '付费内容' : undefined,
    }));
}

interface ViewData {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  duration: number;
  desc?: string;
  pubdate?: number;
  tname?: string;
  stat?: { view: number; danmaku: number; reply: number; favorite: number; coin: number; share: number; like: number };
  owner: { name: string };
  pages: { cid: number; page: number; part: string; duration: number }[];
  ugc_season?: {
    title: string;
    sections: { episodes: { bvid: string; cid: number; title: string; page?: { duration: number } }[] }[];
  };
}

/** What the preview pane shows for a video. */
export interface VideoInfo {
  title: string;
  uploader: string;
  duration?: number;
  published?: string;
  category?: string;
  stats: { label: string; value: number | string }[];
  description: string;
}

export async function biliInfo(bvid: string, signal?: AbortSignal): Promise<VideoInfo> {
  const v = await biliClient().api<ViewData>('https://api.bilibili.com/x/web-interface/wbi/view', { bvid }, signal);
  const s = v.stat;
  return {
    title: v.title,
    uploader: v.owner.name,
    duration: v.duration,
    published: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : undefined,
    category: v.tname || undefined,
    stats: s
      ? [
          { label: '播放', value: s.view },
          { label: '点赞', value: s.like },
          { label: '投币', value: s.coin },
          { label: '收藏', value: s.favorite },
          { label: '弹幕', value: s.danmaku },
          { label: '评论', value: s.reply },
          { label: '分享', value: s.share },
        ]
      : [],
    description: (v.desc ?? '').trim(),
  };
}

export async function biliListing(input: string, signal?: AbortSignal): Promise<Listing> {
  // 番剧 / 电影 / 纪录片 (pgc): episodes of a season.
  if (parseBangumi(input)) return bangumiListing(input, signal);
  // An UP主's uploads, a 收藏夹, a 合集 / 系列.
  const space = parseSpace(input);
  if (space) return spaceListing(space, biliListing, signal);
  const ref = await parseBili(input, signal);
  const client = biliClient();
  const view = await client.api<ViewData>(
    'https://api.bilibili.com/x/web-interface/wbi/view',
    ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid! },
    signal,
  );
  const uploader = view.owner.name;
  const thumb = view.pic;

  if (view.pages.length > 1) {
    const entries = view.pages.map<Entry>((p) => ({
      id: `${view.bvid}:${p.cid}`,
      title: `P${p.page} ${p.part}`,
      duration: p.duration,
      resolve: (s) => resolvePlay(view.bvid, p.cid, `${view.title} - P${p.page} ${p.part}`, uploader, thumb, s),
    }));
    const current = Math.max(0, Math.min(entries.length - 1, (ref.page ?? 1) - 1));
    return { title: view.title, uploader, entries, current, pinned: ref.page !== undefined };
  }

  const episodes = view.ugc_season?.sections.flatMap((s) => s.episodes) ?? [];
  if (episodes.length > 1) {
    const entries = episodes.map<Entry>((e) => ({
      id: `${e.bvid}:${e.cid}`,
      title: e.title,
      duration: e.page?.duration,
      resolve: (s) => resolvePlay(e.bvid, e.cid, e.title, uploader, undefined, s),
    }));
    const current = Math.max(0, episodes.findIndex((e) => e.bvid === view.bvid));
    // A season link is a link to one video in it; the season is offered as "全部".
    return { title: `合集：${view.ugc_season!.title}`, uploader, entries, current, pinned: true };
  }

  const page = view.pages[0]!;
  return {
    title: view.title,
    uploader,
    current: 0,
    entries: [
      {
        id: `${view.bvid}:${page.cid}`,
        title: view.title,
        duration: page.duration,
        resolve: (s) => resolvePlay(view.bvid, page.cid, view.title, uploader, thumb, s),
      },
    ],
  };
}

interface DashStream {
  id: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[] | null;
  backup_url?: string[] | null;
  bandwidth: number;
  codecs: string;
  codecid?: number;
  width?: number;
  height?: number;
  frameRate?: string;
}

export interface PlayData {
  /** 番剧: 1 = only a few minutes' trial for this account (members-only episode). */
  is_preview?: number;
  accept_quality: number[];
  accept_description: string[];
  timelength: number;
  dash?: {
    duration: number;
    video: DashStream[];
    audio: DashStream[] | null;
    flac?: { audio: DashStream | null } | null;
    dolby?: { audio: DashStream[] | null } | null;
  };
}

// avc first: plays everywhere. hevc/av1 are smaller but less compatible.
const CODEC_RANK: Record<number, number> = { 7: 0, 12: 1, 13: 2 };

async function resolvePlay(
  bvid: string,
  cid: number,
  title: string,
  uploader: string,
  thumbnail: string | undefined,
  signal?: AbortSignal,
): Promise<Resolved> {
  const play = await biliClient().api<PlayData>(
    'https://api.bilibili.com/x/player/wbi/playurl',
    { bvid, cid, qn: 0, fnval: 4048, fnver: 0, fourk: 1 },
    signal,
  );
  return fromPlay(play, title, uploader, thumbnail);
}

/** Formats from a playurl answer (videos and 番剧 alike). */
export function fromPlay(play: PlayData, title: string, uploader: string, thumbnail: string | undefined): Resolved {
  if (!play.dash) throw new FatalError('这个视频没有提供 DASH 流，暂不支持。');
  const duration = play.dash.duration || play.timelength / 1000;
  const names = new Map(play.accept_quality.map((q, i) => [q, play.accept_description[i] ?? `${q}`]));

  const audios = [...(play.dash.audio ?? [])].sort((a, b) => b.bandwidth - a.bandwidth);
  const bestAudio = audios[0] ? toStream(audios[0]) : undefined;

  const byQuality = new Map<number, DashStream>();
  for (const v of play.dash.video) {
    const cur = byQuality.get(v.id);
    const rank = (s: DashStream) => CODEC_RANK[s.codecid ?? 0] ?? 9;
    if (!cur || rank(v) < rank(cur)) byQuality.set(v.id, v);
  }

  const formats: Format[] = [...byQuality.values()]
    .sort((a, b) => b.id - a.id)
    .map((v) => ({
      id: `q${v.id}`,
      label: `${names.get(v.id) ?? `${v.height}p`} · ${codecName(v.codecs)}`,
      video: toStream(v),
      audio: bestAudio,
      ext: 'mp4' as const,
      height: v.height,
    }));

  // The site lists every quality the video has; the ones missing from the streams need a login
  // (1080P and up) or a membership (1080P+, 60fps, 4K, HDR …).
  const loggedIn = biliClient().loggedIn;
  const locked = play.accept_quality
    .filter((q) => !byQuality.has(q))
    .sort((a, b) => b - a)
    .map((q) => ({
      label: names.get(q) ?? `${q}`,
      reason: !loggedIn && q <= 80 ? '登录后可下载' : '需要大会员',
      site: 'bili',
    }));

  const flac = play.dash.flac?.audio;
  if (flac) formats.push({ id: 'flac', label: '仅音频 · flac 无损', audio: toStream(flac), ext: 'flac' });
  if (bestAudio) {
    formats.push({ id: 'audio', label: '仅音频 · m4a', audio: bestAudio, ext: 'm4a' });
    // Transcoded by the bundled ffmpeg.
    formats.push({ id: 'audio-mp3', label: '仅音频 · mp3', audio: bestAudio, ext: 'mp3' });
  }

  return { title, uploader, duration, thumbnail, formats, locked, headers: { ...BILI_HEADERS } };
}

function toStream(s: DashStream): Stream {
  return {
    url: s.baseUrl ?? s.base_url ?? '',
    backups: s.backupUrl ?? s.backup_url ?? [],
    codec: s.codecs,
    bandwidth: s.bandwidth,
  };
}

function codecName(codecs: string): string {
  if (codecs.startsWith('avc')) return 'H.264';
  if (codecs.startsWith('hev') || codecs.startsWith('hvc')) return 'H.265';
  if (codecs.startsWith('av01')) return 'AV1';
  return codecs;
}
