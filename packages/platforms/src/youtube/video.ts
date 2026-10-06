import { FatalError, getText } from '@salvia/core';
import type { Entry, Listing, Resolved } from '@salvia/video';
import { PLAYER_CLIENTS, WEB } from './config.ts';
import { buildFormats, type RawFormat } from './formats.ts';
import { collect, innertube, parseClock, text } from './innertube.ts';

const ID = /^[\w-]{11}$/;

export function parseYouTube(input: string): { videoId?: string; listId?: string } {
  const url = new URL(input);
  const list = url.searchParams.get('list') ?? undefined;
  let id = url.searchParams.get('v') ?? undefined;
  if (!id && url.hostname.endsWith('youtu.be')) id = url.pathname.slice(1, 12);
  if (!id) id = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)?.[1];
  // Mixes (RD…) are endless and personal; treat them as the single video.
  const listId = list && !list.startsWith('RD') ? list : undefined;
  return { videoId: id && ID.test(id) ? id : undefined, listId };
}

interface PlayerResponse {
  playabilityStatus?: { status: string; reason?: string; messages?: string[] };
  videoDetails?: { videoId: string; title: string; author: string; lengthSeconds: string; isLive?: boolean };
  streamingData?: { adaptiveFormats?: RawFormat[] };
}

export async function resolveVideo(videoId: string, signal?: AbortSignal): Promise<Resolved> {
  let reason = '';
  for (const client of PLAYER_CLIENTS) {
    const ask = (freshVisitor = false) =>
      innertube<PlayerResponse>('player', client, { videoId, contentCheckOk: true, racyCheckOk: true }, signal, { freshVisitor });
    let res = await ask();
    // The bot check is tied to the visitor session; a new one usually clears it.
    if (res.playabilityStatus?.status === 'LOGIN_REQUIRED' && /not a bot/i.test(res.playabilityStatus.reason ?? '')) {
      res = await ask(true);
    }
    const status = res.playabilityStatus?.status;
    const details = res.videoDetails;
    const adaptive = res.streamingData?.adaptiveFormats ?? [];
    if (status !== 'OK' || !details || !adaptive.length) {
      reason = res.playabilityStatus?.reason ?? res.playabilityStatus?.messages?.[0] ?? reason;
      continue;
    }
    if (details.isLive) throw new FatalError('暂不支持直播。');
    const formats = buildFormats(adaptive);
    if (!formats.length) continue;
    return {
      title: details.title,
      uploader: details.author,
      duration: Number(details.lengthSeconds),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      formats,
      headers: { 'user-agent': client.userAgent },
    };
  }
  throw new FatalError(explain(reason));
}

function explain(reason: string): string {
  if (/not a bot/i.test(reason)) return 'YouTube 暂时要求人机验证（针对当前网络），请稍后重试或换个网络。';
  if (/sign in|confirm your age|age/i.test(reason)) return '这个视频需要登录（如年龄限制），暂不支持。';
  if (/private/i.test(reason)) return '这是私享视频。';
  if (/unavailable|removed|terminated/i.test(reason)) return '视频不可用或已被删除。';
  if (/country/i.test(reason)) return '这个视频在当前地区不可用。';
  return reason ? `YouTube：${reason}` : 'YouTube 没有返回可下载的格式。';
}

function videoEntry(id: string, title = id, duration?: number): Entry {
  return { id, title, duration, resolve: (signal) => resolveVideo(id, signal) };
}

interface Lockup {
  contentId: string;
  contentType: string;
  metadata?: { lockupMetadataViewModel?: { title?: { content?: string } } };
}

async function playlist(listId: string, signal?: AbortSignal, maxPages = 50): Promise<Listing> {
  type Browse = Record<string, unknown>;
  let page = await innertube<Browse>('browse', WEB, { browseId: `VL${listId}` }, signal);
  const header = collect<{ pageTitle?: string }>(page, 'pageHeaderRenderer')[0];
  const title = header?.pageTitle ?? collect<{ title?: string }>(page, 'playlistMetadataRenderer')[0]?.title ?? '播放列表';
  const entries: Entry[] = [];
  const seen = new Set<string>();

  for (let guard = 0; guard < maxPages; guard++) {
    for (const l of collect<Lockup>(page, 'lockupViewModel')) {
      if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || seen.has(l.contentId)) continue;
      seen.add(l.contentId);
      const badge = collect<{ text?: string }>(l, 'thumbnailBadgeViewModel').map((b) => b.text ?? '');
      const duration = badge.map(parseClock).find((d) => d !== undefined);
      entries.push(videoEntry(l.contentId, l.metadata?.lockupMetadataViewModel?.title?.content, duration));
    }
    const token = collect<{ token?: string }>(page, 'continuationCommand').find((c) => c.token)?.token;
    if (!token) break;
    page = await innertube<Browse>('browse', WEB, { continuation: token }, signal);
  }
  if (!entries.length) throw new FatalError('播放列表是空的，或者是私享列表。');
  return { title, entries, current: 0 };
}

/** Channel links: /channel/UC…, or /@handle, /c/name, /user/name (their page names the channel id). */
export async function channelId(input: string, signal?: AbortSignal): Promise<string | undefined> {
  const path = new URL(input).pathname;
  const direct = path.match(/^\/channel\/(UC[\w-]{22})/)?.[1];
  if (direct) return direct;
  const named = path.match(/^\/(@[^/]+|c\/[^/]+|user\/[^/]+)/)?.[0];
  if (!named) return undefined;
  const page = await getText(`https://www.youtube.com${named}`, { headers: { 'accept-language': 'en' }, signal });
  return (
    page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
    page.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/)?.[1] ??
    page.match(/"externalId":"(UC[\w-]{22})"/)?.[1]
  );
}

export async function youtubeListing(input: string, signal?: AbortSignal): Promise<Listing> {
  const { videoId, listId } = parseYouTube(input);
  if (videoId) return { title: '', entries: [videoEntry(videoId)], current: 0 };
  if (listId) return playlist(listId, signal);
  // A channel: its uploads, newest first (the latest few hundred).
  const channel = await channelId(input, signal);
  if (channel) return playlist(`UU${channel.slice(2)}`, signal, 5);
  throw new FatalError('没有识别出 YouTube 视频、播放列表或频道。');
}

/** Description, views, likes and date from the watch page data (`next`). */
export async function youtubeInfo(videoId: string, signal?: AbortSignal): Promise<{
  title: string;
  uploader: string;
  published?: string;
  stats: { label: string; value: number | string }[];
  description: string;
}> {
  const next = await innertube<Record<string, unknown>>('next', WEB, { videoId }, signal);
  const primary = collect<{ title?: unknown; dateText?: unknown }>(next, 'videoPrimaryInfoRenderer')[0];
  const owner = collect<{ title?: unknown; subscriberCountText?: unknown }>(next, 'videoOwnerRenderer')[0];
  const views = collect<{ viewCount?: unknown }>(next, 'videoViewCountRenderer')[0];
  const like = collect<{ title?: string; iconName?: string }>(next, 'buttonViewModel').find((b) => b.iconName === 'LIKE');
  const description = collect<{ content?: string }>(next, 'attributedDescription')[0]?.content ?? '';
  // The web client answers in English: "29,926,325 views", "Streamed live on Jun 3, 2024", "89.5K subscribers".
  const viewCount = Number(text(views?.viewCount).replace(/\D/g, '')) || '';
  const date = new Date(`${text(primary?.dateText).match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/)?.[0]} UTC`);
  return {
    title: text(primary?.title),
    uploader: text(owner?.title),
    published: Number.isNaN(date.getTime()) ? text(primary?.dateText) || undefined : date.toISOString().slice(0, 10),
    stats: [
      { label: '播放', value: viewCount },
      { label: '点赞', value: like?.title ?? '' },
      { label: '订阅', value: text(owner?.subscriberCountText).replace(/\s*subscribers?$/i, '') },
    ].filter((s) => s.value),
    description: description.trim(),
  };
}

export interface SearchResult {
  id: string;
  title: string;
  channel: string;
  /** seconds */
  duration?: number;
  /** Why it can't be downloaded: members only, live, not yet premiered. */
  locked?: string;
}

interface VideoRenderer {
  videoId: string;
  title: unknown;
  longBylineText?: unknown;
  ownerText?: unknown;
  lengthText?: unknown;
  badges?: { metadataBadgeRenderer?: { style?: string; label?: string } }[];
  upcomingEventData?: unknown;
}

/** Members-only, live now, or an upcoming premiere: nothing to download (yet). */
function lockOf(v: VideoRenderer): string | undefined {
  const styles = (v.badges ?? []).map((b) => b.metadataBadgeRenderer?.style ?? '');
  if (styles.includes('BADGE_STYLE_TYPE_MEMBERS_ONLY')) return '频道会员专享';
  if (v.upcomingEventData) return '尚未首播';
  if (styles.includes('BADGE_STYLE_TYPE_LIVE_NOW')) return '正在直播';
  return undefined;
}

/** Plain YouTube search (videos only). Used to match Spotify tracks. */
export async function youtubeSearch(query: string, signal?: AbortSignal, limit = 10): Promise<SearchResult[]> {
  // "EgIQAQ==" = filter: type video
  const res = await innertube('search', WEB, { query, params: 'EgIQAQ==' }, signal);
  return collect<VideoRenderer>(res, 'videoRenderer')
    .slice(0, limit)
    .map((v) => ({
      id: v.videoId,
      title: text(v.title),
      channel: text(v.longBylineText ?? v.ownerText),
      duration: parseClock(text(v.lengthText)),
      locked: lockOf(v),
    }));
}
