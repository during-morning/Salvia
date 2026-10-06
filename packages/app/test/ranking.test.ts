import { beforeAll, describe, expect, it } from 'vitest';
import { rankSearch } from '@salvia/music';
import { installAll } from '../src/index.ts';

// Ranking tiers come from what each platform provider says it is (a video site …).
beforeAll(() => installAll());

describe('music search ranking', () => {
  it('ranks music platforms first, then B站 / YouTube uploads, then unavailable ones', () => {
    const t = (id: string, source: string, playable?: boolean) => ({ id, source, title: '晴天', artists: ['周杰伦'], playable }) as never;
    const ranked = rankSearch([t('1', 'bilibili'), t('2', 'qq', false), t('3', 'netease'), t('4', 'youtube'), t('5', 'kugou')], '晴天');
    expect(ranked.map((x: { id: string }) => x.id)).toEqual(['3', '5', '1', '4', '2']);
  });
});
