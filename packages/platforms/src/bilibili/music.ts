import { FatalError } from '@salvia/core';
import { audioList, audioLyrics, audioQualities, isAudioTrack, parseAudio } from './audio.ts';
import { BILI_HEADERS } from './client.ts';
import { biliListing, bilibiliSearch } from './video.ts';
import type { AudioMatcher, MusicProvider, Quality, Track } from '@salvia/music';

/**
 * B站 as a music source (as in go-music-dl): videos found by name, only the audio track
 * downloaded — the Hi-Res FLAC stream when the uploader provided one, else the best AAC.
 */

function bvidOf(input: string): string | undefined {
  return input.match(/BV[0-9A-Za-z]{10}/)?.[0];
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const hits = await bilibiliSearch(query, signal);
  return hits.map((h) => ({
    id: h.id,
    source: 'bilibili' as const,
    title: h.title,
    artists: [h.channel].filter(Boolean),
    duration: h.duration,
    // 充电专属 / 付费: hidden with the other unavailable results.
    playable: h.locked ? false : undefined,
    extra: h.locked ? { locked: h.locked } : undefined,
  }));
}

async function qualities(t: Track, signal?: AbortSignal): Promise<Quality[]> {
  // 音频区 songs (au号) are files of their own.
  if (isAudioTrack(t)) return audioQualities(t, signal);
  const listing = await biliListing(t.id, signal);
  const entry = listing.entries[listing.current] ?? listing.entries[0];
  if (!entry) return [];
  const res = await entry.resolve(signal);
  // Audio-only formats, each stream once (the "mp3" one is a transcode of the same AAC stream).
  return res.formats
    .filter((f) => !f.video && f.audio && f.ext !== 'mp3')
    .map((f) => ({
      id: f.id,
      label: f.ext === 'flac' ? '无损 FLAC' : 'AAC',
      ext: f.ext === 'flac' ? ('flac' as const) : ('m4a' as const),
      kbps: f.audio!.bandwidth ? Math.round(f.audio!.bandwidth / 1000) : undefined,
      size: f.audio!.bandwidth && res.duration ? Math.round((f.audio!.bandwidth / 8) * res.duration) : undefined,
      approxSize: true,
      url: f.audio!.url,
      mirrors: f.audio!.backups,
    }));
}

export const bilibiliMusic: MusicProvider = {
  source: 'bilibili',
  name: 'B站',
  video: true,
  site: 'bili',
  headers: BILI_HEADERS,
  // Video links open as videos; this provider takes 音频区 links (au / am) and `@music:bilibili`.
  async list(url, signal) {
    if (parseAudio(url)) return audioList(url, signal);
    const bvid = bvidOf(url);
    if (!bvid) throw new FatalError('没有识别出 B站视频编号。');
    const listing = await biliListing(bvid, signal);
    const entry = listing.entries[listing.current]!;
    const t: Track = { id: bvid, source: 'bilibili', title: entry.title, artists: [listing.uploader ?? ''].filter(Boolean), duration: entry.duration };
    return { title: t.title, kind: 'track', tracks: [t] };
  },
  search,
  qualities,
  lyrics: (t, signal) => (isAudioTrack(t) ? audioLyrics(t, signal) : Promise.resolve(undefined)),
};

/** Matches tracks of metadata-only platforms against B站 uploads (when YouTube can't be reached, or by choice). */
export const bilibiliMatcher: AudioMatcher = {
  id: 'bilibili',
  name: 'B站',
  site: 'bili',
  provider: 'bilibili',
  rank: 1,
  async candidates(t, signal) {
    const hits = await bilibiliSearch(`${t.artists[0] ?? ''} ${t.title}`, signal).catch(() => []);
    return hits.filter((h) => !h.locked);
  },
};
