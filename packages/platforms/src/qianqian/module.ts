import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { qianqian } from './index.ts';

/** 千千音乐。 */
export const qianqianModule: SalviaModule = {
  id: 'qianqian',
  setup(api) {
    api.host({ pattern: /(^|\.)(91q|taihe)\.com$/i, kind: 'music', site: 'qianqian' });
    api.platform({ type: 'music', id: 'qianqian', name: '千千音乐', aliases: ['qq-qianqian', '91q', 'taihe', '千千'] });
    api.id({ pattern: /^T\d{6,}$/i, kind: 'music', site: 'qianqian', link: (id) => `https://music.91q.com/song/${id.toUpperCase()}`, platform: 'qianqian', bare: -1, label: '千千 T号' });
    api.site({ id: 'qianqian', name: '千千音乐', hosts: /(^|\.)(91q|taihe)\.com$/, region: 'cn', probe: 'https://music.91q.com/' });
    api.provide(MUSIC_PROVIDERS, { ...qianqian, site: 'qianqian', exactRank: 5 });
  },
};
