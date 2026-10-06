import { describe, expect, it } from 'vitest';
import { acceptable, confident, rank, ratio, slug } from '../src/match.ts';
import type { Track } from '../src/model.ts';

const track: Track = { id: 'x', source: 'spotify', title: 'Blinding Lights', artists: ['The Weeknd'], duration: 200, explicit: false };

describe('match', () => {
  it('slug and ratio', () => {
    expect(slug('Beyoncé — Halo!')).toBe('beyonce halo');
    expect(ratio('abc', 'abc')).toBe(100);
    expect(ratio('abc', 'xyz')).toBe(0);
    expect(Math.round(ratio('kitten', 'sitting'))).toBe(62);
  });

  it('prefers the official audio over live, cover and wrong-length uploads', () => {
    const ranked = rank(track, [
      { id: 'live', title: 'The Weeknd - Blinding Lights (Live at the Super Bowl)', channel: 'The Weeknd', duration: 260 },
      { id: 'cover', title: 'Blinding Lights - The Weeknd (Piano Cover)', channel: 'Some Pianist', duration: 201 },
      { id: 'topic', title: 'Blinding Lights', channel: 'The Weeknd - Topic', duration: 201 },
      { id: 'mv', title: 'The Weeknd - Blinding Lights (Official Video)', channel: 'TheWeekndVEVO', duration: 263 },
      { id: 'other', title: 'Blinding Lights', channel: 'Random Band', duration: 180 },
    ]);
    expect(ranked[0]!.candidate.id).toBe('topic');
    expect(confident(ranked[0], track)).toBe(true);
    const ids = ranked.map((r) => r.candidate.id);
    expect(ids.indexOf('cover')).toBeGreaterThan(ids.indexOf('mv'));
    expect(ids.indexOf('live')).toBeGreaterThan(ids.indexOf('mv'));
  });

  it('batch downloads accept a decent top hit that is not "confident", but not a different song', () => {
    const [mv] = rank(track, [{ id: 'mv', title: 'The Weeknd - Blinding Lights (Official Video)', channel: 'TheWeekndVEVO', duration: 263 }]);
    expect(confident(mv, track)).toBe(false); // 63 s longer: intro/outro
    expect(acceptable(mv, track)).toBe(false); // too far off for unattended use
    const [lyric] = rank(track, [{ id: 'ly', title: 'Blinding Lights - The Weeknd (Lyrics)', channel: 'Some Lyrics', duration: 205 }]);
    expect(acceptable(lyric, track)).toBe(true);
    const [other] = rank(track, [{ id: 'z', title: 'Save Your Tears', channel: 'The Weeknd - Topic', duration: 215 }]);
    expect(acceptable(other, track)).toBe(false);
  });

  it('is not confident about a different song', () => {
    const [best] = rank(track, [{ id: 'z', title: 'Save Your Tears', channel: 'The Weeknd - Topic', duration: 215 }]);
    expect(confident(best, track)).toBe(false);
  });
});
