import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { soda } from './index.ts';

/** 汽水音乐：歌曲信息（音频来自匹配）。 */
export const sodaModule: SalviaModule = {
  id: 'soda',
  setup(api) {
    api.host({ pattern: /(^|\.)qishui\.com$/i, kind: 'music', site: 'soda' });
    api.host({ pattern: /(^|\.)qishui\.douyin\.com$/i, kind: 'music', site: 'soda' });
    api.platform({ type: 'music', id: 'soda', name: '汽水音乐', aliases: ['qishui', '汽水'] });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'soda', link: (id) => `https://www.qishui.com/track/${id}`, platform: 'soda' });
    api.site({ id: 'soda', name: '汽水音乐', hosts: /(^|\.)(qishui\.com|qishui\.douyin\.com)$/ });
    api.provide(MUSIC_PROVIDERS, { ...soda, site: 'soda' });
  },
};
