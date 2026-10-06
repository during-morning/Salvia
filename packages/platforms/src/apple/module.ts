import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { apple } from './index.ts';

/** Apple Music：歌曲信息与试听（音频来自匹配）。 */
export const appleModule: SalviaModule = {
  id: 'apple',
  setup(api) {
    api.host({ pattern: /(^|\.)music\.apple\.com$/i, kind: 'music', site: 'apple' });
    api.platform({ type: 'music', id: 'apple', name: 'Apple Music', aliases: ['apple-music', 'am'] });
    // iTunes links name the same songs and albums.
    api.host({ pattern: /(^|\.)itunes\.apple\.com$/i, kind: 'music', site: 'apple' });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'apple', link: (id) => `https://music.apple.com/cn/song/${id}`, platform: 'apple' });
    api.site({ id: 'apple', name: 'Apple Music', hosts: /(^|\.)(music\.apple\.com|apple\.com|mzstatic\.com)$/ });
    api.provide(MUSIC_PROVIDERS, { ...apple, site: 'apple' });
  },
};
