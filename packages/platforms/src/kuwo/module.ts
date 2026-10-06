import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { kuwo } from './index.ts';

/** 酷我音乐。 */
export const kuwoModule: SalviaModule = {
  id: 'kuwo',
  setup(api) {
    api.host({ pattern: /(^|\.)kuwo\.cn$/i, kind: 'music', site: 'kuwo' });
    api.platform({ type: 'music', id: 'kuwo', name: '酷我音乐', aliases: ['kw', '酷我'] });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'kuwo', link: (id) => `https://www.kuwo.cn/play_detail/${id}`, platform: 'kuwo', label: '酷我 rid' });
    api.site({ id: 'kuwo', name: '酷我音乐', hosts: /(^|\.)(kuwo\.cn|kwcdn\.kuwo\.cn)$/, region: 'cn', probe: 'https://www.kuwo.cn/' });
    api.provide(MUSIC_PROVIDERS, { ...kuwo, site: 'kuwo', defaultSearch: true, exactRank: 3 });
  },
};
