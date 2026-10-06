import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { joox } from './index.ts';

/** JOOX。 */
export const jooxModule: SalviaModule = {
  id: 'joox',
  setup(api) {
    api.host({ pattern: /(^|\.)joox\.com$/i, kind: 'music', site: 'joox' });
    api.platform({ type: 'music', id: 'joox', name: 'JOOX' });
    api.id({ pattern: /^[\w+=-]{16,}$/, kind: 'music', site: 'joox', link: (id) => `https://www.joox.com/hk/single/${id}`, platform: 'joox' });
    api.site({ id: 'joox', name: 'JOOX', hosts: /(^|\.)joox\.com$/ });
    api.provide(MUSIC_PROVIDERS, { ...joox, site: 'joox', exactRank: 6 });
  },
};
