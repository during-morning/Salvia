export interface Stream {
  url: string;
  /** Mirror URLs tried in order when `url` fails. */
  backups: string[];
  codec: string;
  /** bits per second */
  bandwidth: number;
  /** bytes, when the site tells us */
  size?: number;
}

export interface Format {
  /** Stable across re-resolves, so a paused job can find "the same" format with fresh URLs. */
  id: string;
  label: string;
  /** Video stream; absent for audio-only. */
  video?: Stream;
  audio?: Stream;
  /** Output container. */
  ext: 'mp4' | 'm4a' | 'mp3' | 'flac' | 'webm';
  height?: number;
}

export interface Resolved {
  title: string;
  uploader?: string;
  /** seconds */
  duration: number;
  thumbnail?: string;
  /** Best first, audio-only last. */
  formats: Format[];
  /** Headers required by the media CDN (Referer etc.). */
  headers: Record<string, string>;
  /** Qualities the site has but won't serve to this session (needs login / membership). */
  locked?: { label: string; reason: string; site: string }[];
}

/** One playable thing: a video, a Bilibili page (分P) or a playlist entry. */
export interface Entry {
  id: string;
  title: string;
  /** seconds, if known before resolving */
  duration?: number;
  /** Shown beside the title, e.g. 会员 for a members-only episode. */
  badge?: string;
  resolve(signal?: AbortSignal): Promise<Resolved>;
}

export interface Listing {
  title: string;
  uploader?: string;
  entries: Entry[];
  /** Index of the entry the URL pointed at (e.g. ?p=3). */
  current: number;
  /** The URL named a specific entry, so jump straight to its formats instead of listing. */
  pinned?: boolean;
}

export function estimateSize(f: Format, duration: number): number | undefined {
  const sum = (s?: Stream) => s?.size ?? (s ? (s.bandwidth * duration) / 8 : 0);
  const total = sum(f.video) + sum(f.audio);
  return total > 0 ? total : undefined;
}

export { formatDuration } from '@salvia/core';
