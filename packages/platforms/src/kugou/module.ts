import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { kugou } from './index.ts';

/** 酷狗音乐。 */
export const kugouModule: SalviaModule = {
  id: 'kugou',
  setup(api) {
    api.host({ pattern: /(^|\.)kugou\.com$/i, kind: 'music', site: 'kugou' });
    api.platform({ type: 'music', id: 'kugou', name: '酷狗音乐', aliases: ['kg', '酷狗'] });
    // A song hash (32 hex) is distinctive enough to work typed alone.
    api.id({ pattern: /^[0-9a-f]{32}$/i, kind: 'music', site: 'kugou', link: (h) => `https://www.kugou.com/song/#hash=${h}`, platform: 'kugou', bare: -1, label: '酷狗 hash' });
    api.site({ id: 'kugou', name: '酷狗音乐', hosts: /(^|\.)(kugou\.com|kgimg\.com)$/, region: 'cn', probe: 'https://songsearch.kugou.com/' });
    api.provide(MUSIC_PROVIDERS, { ...kugou, site: 'kugou', defaultSearch: true, exactRank: 2 });
  },
};
