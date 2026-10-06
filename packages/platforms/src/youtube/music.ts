import { FatalError } from '@salvia/core';
import type { AudioMatcher, MusicProvider, Track } from '@salvia/music';
import { downloadFormat } from '@salvia/video';
import { resolveVideo, youtubeListing, youtubeSearch } from './video.ts';

/** The audio stream of a video (AAC in MP4). */
async function audioOf(id: string, signal?: AbortSignal) {
  const res = await resolveVideo(id, signal);
  const fmt = res.formats.find((f) => f.id === 'audio');
  if (!fmt?.audio) throw new FatalError('这个视频没有音频流。');
  return { res, fmt };
}

/**
 * YouTube as a music source for `@music:youtube` / `@music:all`: videos found by name, the audio
 * track downloaded (the same path Spotify matches take). Ranked after the music platforms.
 */
export const youtubeMusic: MusicProvider = {
  source: 'youtube',
  name: 'YouTube',
  video: true,
  site: 'youtube',
  // Unreachable from this network: search B站 instead.
  standIn: 'bilibili',
  async fetchAudio(t, out, signal, report) {
    const { res, fmt } = await audioOf(t.id, signal);
    // Kept as the raw m4a; the music feature tags (and converts) it in one ffmpeg pass.
    await downloadFormat(res, { ...fmt, ext: 'm4a' }, out, { signal, report, chunkSize: 9 * 1024 * 1024 });
    return { codec: 'mp4a', ext: 'm4a' };
  },
  async clip(t, signal) {
    const { fmt } = await audioOf(t.id, signal);
    return { url: fmt.audio!.url, start: t.duration ? Math.min(45, Math.round(t.duration * 0.3)) : 0, duration: 30 };
  },
  // Links to YouTube open as videos; this provider is for searches.
  async list(url, signal) {
    const listing = await youtubeListing(url, signal);
    const entry = listing.entries[listing.current];
    if (!entry) throw new FatalError('没有识别出 YouTube 视频。');
    const t: Track = { id: entry.id, source: 'youtube', title: entry.title, artists: [listing.uploader ?? ''].filter(Boolean), duration: entry.duration };
    return { title: t.title, kind: 'track', tracks: [t] };
  },
  async search(query, signal) {
    const hits = await youtubeSearch(query, signal, 20);
    return hits.map((h) => ({
      id: h.id,
      source: 'youtube' as const,
      title: h.title,
      artists: [h.channel.replace(/\s*-\s*Topic$/i, '')].filter(Boolean),
      duration: h.duration,
      playable: h.locked ? false : undefined,
      extra: h.locked ? { locked: h.locked } : undefined,
    }));
  },
};

/** Matches tracks of metadata-only platforms (Spotify …) against YouTube uploads. */
export const youtubeMatcher: AudioMatcher = {
  id: 'youtube',
  name: 'YouTube',
  site: 'youtube',
  provider: 'youtube',
  rank: 0,
  async candidates(t, signal) {
    const artist = t.artists[0] ?? '';
    const queries = [`${artist} - ${t.title}`, `${artist} ${t.title} audio`];
    const results = await Promise.all(queries.map((q) => youtubeSearch(q, signal, 8).catch(() => [])));
    return results.flat().filter((r) => !r.locked);
  },
};
