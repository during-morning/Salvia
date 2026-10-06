import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { migu } from './index.ts';

/** 咪咕音乐。 */
export const miguModule: SalviaModule = {
  id: 'migu',
  setup(api) {
    api.host({ pattern: /(^|\.)migu\.cn$/i, kind: 'music', site: 'migu' });
    api.platform({ type: 'music', id: 'migu', name: '咪咕音乐', aliases: ['mg', '咪咕'] });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'migu', link: (id) => `https://music.migu.cn/v3/music/song/${id}`, platform: 'migu', label: '咪咕歌曲号' });
    api.site({ id: 'migu', name: '咪咕音乐', hosts: /(^|\.)migu\.cn$/, region: 'cn', probe: 'https://pd.musicapp.migu.cn/' });
    api.provide(MUSIC_PROVIDERS, { ...migu, site: 'migu', defaultSearch: true, exactRank: 4 });
  },
};
