import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { fivesing } from './index.ts';

/** 5sing（原创 / 翻唱）。 */
export const fivesingModule: SalviaModule = {
  id: 'fivesing',
  setup(api) {
    api.host({ pattern: /(^|\.)5sing\.kugou\.com$/i, kind: 'music', site: 'fivesing' });
    api.platform({ type: 'music', id: 'fivesing', name: '5sing', aliases: ['5sing'] });
    api.id({
      pattern: /^(yc|fc|bz)-?\d+$/i,
      kind: 'music',
      site: 'fivesing',
      link: (id) => {
        const [, type, n] = id.toLowerCase().match(/^(yc|fc|bz)-?(\d+)$/)!;
        return `https://5sing.kugou.com/${type}/${n}.html`;
      },
      platform: 'fivesing',
      bare: -1,
      label: '5sing yc/fc号',
    });
    api.site({ id: 'fivesing', name: '5sing', hosts: /(^|\.)5sing\.kugou\.com$/, region: 'cn', probe: 'https://5sing.kugou.com/' });
    api.provide(MUSIC_PROVIDERS, { ...fivesing, site: 'fivesing', exactRank: 8 });
  },
};
