import type { SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { jamendo } from './index.ts';

/** Jamendo（CC 授权的独立音乐）。 */
export const jamendoModule: SalviaModule = {
  id: 'jamendo',
  setup(api) {
    api.host({ pattern: /(^|\.)jamendo\.com$/i, kind: 'music', site: 'jamendo' });
    api.platform({ type: 'music', id: 'jamendo', name: 'Jamendo' });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'jamendo', link: (id) => `https://www.jamendo.com/track/${id}`, platform: 'jamendo' });
    api.site({ id: 'jamendo', name: 'Jamendo', hosts: /(^|\.)(jamendo\.com|jamen\.do)$/ });
    api.provide(MUSIC_PROVIDERS, { ...jamendo, site: 'jamendo', exactRank: 7 });
  },
};
