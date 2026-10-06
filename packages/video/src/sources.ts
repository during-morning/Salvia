import { provided, slot, type Context, type PreviewData } from '@salvia/core';
import type { Listing } from './model.ts';

/** A search result on a video site. */
export interface VideoHit {
  id: string;
  title: string;
  channel: string;
  /** seconds */
  duration?: number;
  /** Why it can't be downloaded (members only, 充电专属, live …): hidden until asked for. */
  locked?: string;
}

/** What a video's detail view shows. */
export interface VideoInfo {
  title: string;
  uploader: string;
  duration?: number;
  published?: string;
  category?: string;
  stats: { label: string; value: number | string }[];
  description: string;
}

/**
 * A video site, as the video feature uses it. Platform modules provide these; the feature routes
 * links to them, searches them, and downloads what they resolve.
 */
export interface VideoSource {
  /** The id links route to (registry `host` site) and `@video:<id>` uses. */
  id: string;
  name: string;
  /** Network id (registry `site`), for the reachability check. */
  site?: string;
  /** A link → its entries (one video, 分P, a playlist, a season). */
  list?(url: string, signal?: AbortSignal): Promise<Listing>;
  /** A custom flow instead of the standard formats list (抖音: images, music, profiles). */
  open?(ctx: Context, url: string): Promise<void>;
  search?(query: string, signal?: AbortSignal): Promise<VideoHit[]>;
  /** The link of a search hit. */
  link?(id: string): string;
  /** Details for the preview pane. */
  info?(hit: VideoHit, signal: AbortSignal): Promise<VideoInfo>;
  /** Piece size for downloads (YouTube throttles single long streams). */
  chunk?: number;
  /** Extra part of the resolve cache key (a login changes which qualities a site serves). */
  cacheKey?(): string;
  /** When this site is unreachable, search this one instead (YouTube → B站). */
  standIn?: string;
}

export const VIDEO_SOURCES = slot<VideoSource>('video.source');

export function videoSources(): VideoSource[] {
  return provided(VIDEO_SOURCES);
}

export function videoSource(id: string): VideoSource | undefined {
  return videoSources().find((s) => s.id === id);
}

/** 12345678 → 1234.6万, the way both big sites count. */
export function count(n: number | string): string {
  if (typeof n === 'string') return n;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

export function infoPreview(info: VideoInfo, hit: VideoHit, sourceName: string, formatDuration: (s: number) => string): PreviewData {
  const duration = info.duration ?? hit.duration;
  return {
    title: info.title || hit.title,
    subtitle: info.uploader || hit.channel,
    fields: [
      ...info.stats.map((s) => ({ label: s.label, value: count(s.value) })),
      { label: '时长', value: duration ? formatDuration(duration) : '' },
      { label: '发布', value: info.published ?? '' },
      { label: '分区', value: info.category ?? '' },
      { label: '平台', value: sourceName },
    ].filter((f) => f.value),
    sections: [{ title: '简介', text: info.description || '（没有简介）' }],
  };
}
