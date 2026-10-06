import anyAscii from 'any-ascii';
import type { Track } from './model.ts';

/**
 * Scoring of YouTube candidates against a track, after spotDL's matcher (utils/matching.py, MIT):
 * slugified names compared by similarity ratio, main artist checked against title and channel,
 * duration difference decaying exponentially, and penalties for versions the track isn't
 * (live, remix, cover, …; heavier than spotDL because plain YouTube durations are noisier).
 */

export interface Candidate {
  id: string;
  title: string;
  channel: string;
  /** seconds */
  duration?: number;
}

export interface Scored {
  candidate: Candidate;
  score: number;
  name: number;
  artist: number;
  time: number;
}

/** ASCII, lower case, words separated by single spaces (CJK becomes pinyin/romaji via any-ascii). */
export function slug(s: string): string {
  return anyAscii(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Similarity 0..100 from the longest common subsequence (same as rapidfuzz's `ratio`). */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 100;
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return (200 * prev[b.length]!) / (a.length + b.length);
}

const FORBIDDEN = [
  'live', 'remix', 'cover', 'instrumental', 'karaoke', 'acoustic', 'nightcore', 'reverb',
  'slowed', 'sped up', 'speed up', '8d', 'bass boosted', 'bassboost', 'lyrics video', 'reaction', 'tutorial',
];

/** Strip decoration YouTube titles carry but track names don't. */
function cleanTitle(s: string): string {
  return slug(
    s
      .replace(/\((official|music|lyric|audio|video|hd|hq|4k|mv|visualizer)[^)]*\)/gi, ' ')
      .replace(/\[(official|music|lyric|audio|video|hd|hq|4k|mv)[^\]]*\]/gi, ' ')
      .replace(/\b(official (music )?video|official audio|lyric video|music video|audio)\b/gi, ' '),
  );
}

export function scoreCandidate(track: Track, c: Candidate): Scored {
  const title = cleanTitle(c.title);
  const channel = slug(c.channel.replace(/\s*-\s*Topic$/i, ''));
  const name = slug(track.title);
  const artists = track.artists.map(slug).filter(Boolean);
  const main = artists[0] ?? '';

  // Name: plain, or with the artist prefixed ("Artist - Title" uploads).
  let nameScore = ratio(name, title);
  if (title.includes(name) && name.length >= 3) nameScore = Math.max(nameScore, 90);
  if (nameScore <= 75) nameScore = Math.max(nameScore, ratio(slug(`${track.artists.join(' ')} ${track.title}`), title));

  // Artist: the main one named in the title or as the channel; others raise it a bit.
  let artistScore = main && (title.includes(main) || channel.includes(main)) ? 100 : Math.max(ratio(main, channel), ratio(main, title) * 0.8);
  if (artists.length > 1) {
    const others = artists.slice(1).filter((a) => title.includes(a) || channel.includes(a)).length;
    artistScore = Math.min(100, artistScore + (others / (artists.length - 1)) * 10);
  }

  const diff = track.duration && c.duration ? Math.abs(track.duration - c.duration) : undefined;
  const time = diff === undefined ? 60 : 100 * Math.exp(-0.1 * diff);

  let score = nameScore * 0.45 + artistScore * 0.35 + time * 0.2;
  const raw = slug(c.title);
  for (const word of FORBIDDEN) {
    if (` ${raw} `.includes(` ${word} `) && !` ${name} `.includes(` ${word} `)) score -= 25;
  }
  if (/\s-\sTopic$/i.test(c.channel)) score += 5; // auto-generated official audio
  if (track.explicit === false && /\bexplicit\b/i.test(c.title)) score -= 5;
  return { candidate: c, score: Math.max(0, Math.min(100, score)), name: nameScore, artist: artistScore, time };
}

export function rank(track: Track, candidates: Candidate[]): Scored[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .map((c) => scoreCandidate(track, c))
    .sort((a, b) => b.score - a.score);
}

/** Good enough to download without asking: a strong score and a duration within 20 seconds. */
export function confident(s: Scored | undefined, track: Track): boolean {
  if (!s || s.score < 70 || s.name < 60 || s.artist < 70) return false;
  const d = s.candidate.duration;
  return !track.duration || !d || Math.abs(track.duration - d) <= 20;
}

/**
 * Good enough for unattended batch downloads (playlists): the top result is the same song even if
 * the upload is not the cleanest. Like spoti-down, take the best hit rather than skip the track,
 * but still refuse clear mismatches.
 */
export function acceptable(s: Scored | undefined, track: Track): boolean {
  if (!s || s.score < 55 || s.name < 50) return false;
  const d = s.candidate.duration;
  return !track.duration || !d || Math.abs(track.duration - d) <= 45;
}
