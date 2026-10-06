import type { AudioClip, Progress } from '@salvia/core';
import type { Candidate } from './match.ts';

/** A provider's id for its tracks (netease, qq, kugou …); see `MusicProvider.source`. */
export type Source = string;

export interface Track {
  /** Provider-specific id (netease song id, qq songmid, spotify track id). */
  id: string;
  source: Source;
  title: string;
  artists: string[];
  album?: string;
  /** seconds */
  duration?: number;
  cover?: string;
  explicit?: boolean;
  /** false = the site says it cannot be played here (VIP-only, region, removed). undefined = unknown until resolved. */
  playable?: boolean;
  /** Extra provider data needed later (qq media_mid, …). */
  extra?: Record<string, string | number>;
}

export interface Quality {
  /** Provider level id: netease 'exhigh' / qq 'M800' … */
  id: string;
  label: string;
  ext: 'mp3' | 'flac' | 'm4a' | 'ogg';
  /** Bitrate in kbps when known, for the table. */
  kbps?: number;
  /** bytes, if known */
  size?: number;
  /** `size` is an estimate (bitrate × duration): shown, but the download measures the real one. */
  approxSize?: boolean;
  /** Resolved stream URL (short-lived). */
  url: string;
  /** Same file on other CDN hosts: downloaded from all of them in parallel. */
  mirrors?: string[];
  /** Only a preview clip (试听) — never offered as a download. */
  trial?: boolean;
}

export interface TrackList {
  title: string;
  kind: 'track' | 'album' | 'playlist' | 'artist';
  tracks: Track[];
}

export interface Lyrics {
  /** Original lyrics in LRC. */
  lrc: string;
  /** Translation in LRC, if any. */
  translation?: string;
}

/**
 * A music platform, as the music feature uses it. Platform modules provide these (`MUSIC_PROVIDERS`);
 * everything the feature needs to know about a platform is said here, never assumed by name.
 */
export interface MusicProvider {
  /** `Track.source` of its tracks. */
  source: Source;
  name: string;
  /** `@music:<id>` (registry platform id) when it differs from `source` (qq → qq-music). */
  platform?: string;
  /** Network id (registry `site`): unreachable ones are skipped in searches and fallbacks. */
  site?: string;
  /** Resolve a song / album / playlist URL. */
  list(url: string, signal?: AbortSignal): Promise<TrackList>;
  search(query: string, signal?: AbortSignal): Promise<Track[]>;
  /** Downloadable qualities for a track, best first. Empty = nothing downloadable. */
  qualities?(track: Track, signal?: AbortSignal): Promise<Quality[]>;
  /**
   * Audio that isn't one URL (a YouTube video's audio stream): write it to `out` and say its
   * codec and container; the feature tags and converts it.
   */
  fetchAudio?(track: Track, out: string, signal: AbortSignal, report: (p: Progress) => void): Promise<{ codec: string; ext: Quality['ext'] }>;
  lyrics?(track: Track, signal?: AbortSignal): Promise<Lyrics | undefined>;
  /** Album intro and release facts, for the preview. */
  intro?(track: Track, signal?: AbortSignal): Promise<{ text?: string; released?: string; company?: string } | undefined>;
  /** A 30-second clip for 试听 when the qualities don't give one. */
  clip?(track: Track, signal: AbortSignal): Promise<AudioClip | undefined>;
  /** Fuller details of a track (release date, preview URL …), for the preview and file tags. */
  details?(track: Track, signal?: AbortSignal): Promise<Track | undefined>;
  /** Headers the audio CDN needs. */
  headers?: Record<string, string>;
  /**
   * Metadata only (Spotify, Apple Music, 汽水): the audio is DRM-protected or not offered, so it
   * comes from the same song on the user's own account elsewhere, a video match, or an exact match.
   */
  matchOnly?: boolean;
  /** A video site (B站, YouTube): uploads rather than releases, ranked after the music platforms. */
  video?: boolean;
  /** Asked by a plain `@music <歌名>`. */
  defaultSearch?: boolean;
  /** Can search right now (Spotify needs a login or credentials). */
  searchable?(): boolean;
  /** Asked for the same song (title + artists identical) when another platform can't serve it; lower first. */
  exactRank?: number;
  /** Asked for lyrics of tracks whose own platform has none. */
  lyricsFallback?: boolean;
  /** The user's own account here: matched songs of metadata-only platforms come from it first. */
  account?: { loggedIn(): boolean };
  /** Search this provider instead when this one's network is unreachable. */
  standIn?: string;
}

/**
 * Finds a track among a video site's uploads (YouTube, B站), for metadata-only platforms. The match
 * is downloaded as a track of `provider`.
 */
export interface AudioMatcher {
  id: string;
  name: string;
  /** Network id, for the reachability check. */
  site?: string;
  /** The music provider whose tracks the candidate ids are. */
  provider: string;
  /** Preference when several are reachable (lower first). */
  rank?: number;
  candidates(track: Track, signal?: AbortSignal): Promise<Candidate[]>;
}

export function artistLine(t: Pick<Track, 'artists'>): string {
  return t.artists.join(' / ');
}
