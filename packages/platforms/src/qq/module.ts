import { CookieJar, loadConfig, type SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { qq } from './index.ts';

/** QQ音乐。 */
export const qqModule: SalviaModule = {
  id: 'qq',
  setup(api) {
    api.host({ pattern: /(^|\.)y\.qq\.com$/i, kind: 'music', site: 'qq' });
    const song = (id: string) => `https://y.qq.com/n/ryqq/songDetail/${id}`;
    api.id({ pattern: /^[0-9A-Za-z]{14}$/, kind: 'music', site: 'qq', link: song, bare: 3, label: 'QQ音乐 songmid' });
    api.id({ pattern: /^\w+$/, kind: 'music', site: 'qq', link: song, platform: 'qq-music' });
    api.platform({ type: 'music', id: 'qq-music', name: 'QQ音乐', aliases: ['qq', 'qqmusic', 'qq音乐'] });
    api.login(
      'qqmusic',
      { name: 'QQ音乐', cookie: 'qq', url: 'https://y.qq.com/', domains: ['y.qq.com', '.qq.com'], needs: ['qqmusic_key', 'qm_keyst'], hint: '点右上角"登录"' },
      ['qq', 'qq-music'],
    );
    api.site({ id: 'qq', name: 'QQ音乐', hosts: /(^|\.)(qq\.com|gtimg\.cn|qqmusic\.qq\.com)$/, prewarm: ['https://c.y.qq.com/', 'https://u.y.qq.com/'] });
    api.provide(MUSIC_PROVIDERS, { ...qq, platform: 'qq-music', site: 'qq', defaultSearch: true, exactRank: 1, account: { loggedIn: () => { const jar = new CookieJar(loadConfig().cookies.qq); return !!(jar.get('qqmusic_key') ?? jar.get('qm_keyst')); } } });
  },
};
