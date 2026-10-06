import { beforeAll, describe, expect, it } from 'vitest';
import { Session, TaskQueue, install } from '@salvia/core';
import { ANIME_SOURCES, animeModule, type AnimeSource } from '../src/index.ts';

// A catalogue source (so `@anime:fake` skips Bangumi: no network) with one offer per title.
const fake: AnimeSource = {
  id: 'fake',
  name: 'Fake',
  official: true,
  catalog: async (keyword) => [{ source: 'fake', id: '1', title: keyword }],
  offers: async (t) => ({ items: [{ id: 'ep', title: `${t.names[0]} 正片` }], summary: '有正版' }),
};

beforeAll(() => install(animeModule, { id: 'fake-anime', setup: (api) => api.provide(ANIME_SOURCES, fake) }));

const settled = () => new Promise((r) => setTimeout(r, 80));

describe('@anime', () => {
  it('opening a title lists its offers', async () => {
    const s = new Session(new TaskQueue());
    await s.input('@anime:fake 芙莉莲');
    const title = s.view().items[0]!;
    expect(title.title).toBe('芙莉莲');
    await s.pick(title.id);
    await settled();
    expect(s.view().items.map((i) => i.title)).toEqual(['芙莉莲 正片']);
    expect(s.view().status.tone).toBe('idle');
  });
});
