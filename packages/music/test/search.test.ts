import { describe, expect, it } from 'vitest';
import { plainLyrics, rankSearch } from '../src/index.ts';
import type { Track } from '../src/model.ts';

const t = (title: string, artist: string, extra: Partial<Track> = {}): Track => ({ id: `${title}/${artist}`, source: 'netease', title, artists: [artist], ...extra });

describe('rankSearch', () => {
  it('puts the original before covers and versions', () => {
    const ranked = rankSearch(
      [
        t('晴天(深情版)', 'Lucky小爱'),
        t('晴天 (原唱 周杰伦)', 'RyaVocal'),
        t('晴天', 'DJ阿福', { playable: false }),
        t('晴天', '周杰伦', { album: '叶惠美' }),
        t('晴天和猫', '花粥'),
      ],
      '晴天',
    );
    expect(ranked[0]!.artists[0]).toBe('周杰伦');
    expect(ranked.slice(-2).map((x) => x.title)).toContain('晴天(深情版)');
  });

  it('a query with the artist matches title + artist', () => {
    const ranked = rankSearch([t('后来 (Live)', '刘若英'), t('后来', '某翻唱'), t('后来', '刘若英')], '后来 刘若英');
    expect(ranked[0]).toMatchObject({ title: '后来', artists: ['刘若英'] });
  });
});

describe('plainLyrics', () => {
  it('drops time tags, metadata and credit JSON lines', () => {
    const lrc = '[ti:晴天]\n{"t":0,"c":[{"tx":"作词: "}]}\n[00:01.00]故事的小黄花\n[00:05.20][00:30.00]从出生那年就飘着\n\n\n\n[01:00.00]';
    expect(plainLyrics(lrc)).toBe('故事的小黄花\n从出生那年就飘着');
  });
});
