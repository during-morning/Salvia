import { beforeAll, describe, expect, it } from 'vitest';
import { install, setReachable } from '@salvia/core';
import { exactMatch } from '../src/exact.ts';
import type { MusicProvider, Track } from '../src/model.ts';
import { MUSIC_PROVIDERS, searchProviders } from '../src/providers.ts';

/** A fake platform that counts its searches and answers after a short delay. */
function fake(source: string, opts: Partial<MusicProvider> & { hits?: Track[] } = {}) {
  const calls = { search: 0, active: 0, peak: 0 };
  const provider: MusicProvider = {
    source,
    name: source.toUpperCase(),
    site: source,
    list: async () => ({ title: '', kind: 'track', tracks: [] }),
    async search() {
      calls.search++;
      calls.active++;
      calls.peak = Math.max(calls.peak, calls.active);
      await new Promise((r) => setTimeout(r, 20));
      calls.active--;
      return opts.hits ?? [];
    },
    qualities: async () => [{ id: 'q', label: '320k', ext: 'mp3', url: 'https://x/a.mp3' }],
    ...opts,
  };
  return { provider, calls };
}

const song = (source: string, title = '晴天'): Track => ({ id: `${source}-1`, source, title, artists: ['周杰伦'], duration: 269 });

const a = fake('fa', { defaultSearch: true, exactRank: 0, hits: [song('fa')] });
const b = fake('fb', { defaultSearch: true, exactRank: 1, standIn: 'fa' });
const c = fake('fc', { exactRank: 2, hits: [song('fc')] });

beforeAll(() => {
  install({
    id: 'fakes',
    setup(api) {
      for (const p of [a, b, c]) api.provide(MUSIC_PROVIDERS, p.provider);
    },
  });
});

describe('search providers', () => {
  it('leaves out platforms found unreachable and says which', () => {
    setReachable('fb', false);
    const { list, skipped } = searchProviders();
    expect(list.map((p) => p.source)).toEqual(['fa']);
    expect(skipped.map((p) => p.source)).toEqual(['fb']);
    setReachable('fb', undefined);
    expect(searchProviders().list.map((p) => p.source)).toEqual(['fa', 'fb']);
  });

  it('asks a stand-in when the named platform is unreachable', () => {
    setReachable('fb', false);
    expect(searchProviders('fb').list.map((p) => p.source)).toEqual(['fa']);
    setReachable('fb', undefined);
  });
});

describe('exact-match fallback', () => {
  it('finds the same song elsewhere, asks once per song, at most three songs at a time', async () => {
    const want: Track = { id: 'x', source: 'other', title: '晴天', artists: ['周杰伦'], duration: 270 };
    const [first, again] = await Promise.all([exactMatch(want), exactMatch(want)]);
    expect(first?.track.source).toBe('fa');
    expect(again).toBe(first);
    const before = a.calls.search;
    await exactMatch(want);
    expect(a.calls.search).toBe(before); // cached

    // Ten different songs at once: lookups queue, three at a time.
    a.calls.peak = 0;
    await Promise.all(Array.from({ length: 10 }, (_, i) => exactMatch({ ...want, title: `歌${i}` })));
    expect(a.calls.peak).toBeLessThanOrEqual(3);
  });

  it('skips unreachable platforms', async () => {
    setReachable('fa', false);
    const hit = await exactMatch({ id: 'y', source: 'other', title: '晴天', artists: ['周杰伦'], duration: 268 });
    expect(hit?.track.source).toBe('fc');
    setReachable('fa', undefined);
  });
});
