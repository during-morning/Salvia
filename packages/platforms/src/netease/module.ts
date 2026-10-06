import { CookieJar, loadConfig, type SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS } from '@salvia/music';
import { netease } from './index.ts';

/** 网易云音乐。 */
export const neteaseModule: SalviaModule = {
  id: 'netease',
  setup(api) {
    api.host({ pattern: /(^|\.)music\.163\.com$/i, kind: 'music', site: 'netease' });
    api.host({ pattern: /(^|\.)163cn\.tv$/i, kind: 'music', site: 'netease' });
    const song = (id: string) => `https://music.163.com/song?id=${id}`;
    api.id({ pattern: /^\d{4,12}$/, kind: 'music', site: 'netease', link: song, bare: 2, label: '网易云歌曲号' });
    api.id({ pattern: /^\d+$/, kind: 'music', site: 'netease', link: song, platform: 'netease' });
    api.platform({ type: 'music', id: 'netease', name: '网易云', aliases: ['163', 'wy', 'wyy', '网易云'] });
    api.login(
      'netease',
      { name: '网易云音乐', cookie: 'netease', url: 'https://music.163.com/', domains: ['music.163.com', '.163.com'], needs: ['MUSIC_U'], hint: '点右上角"登录"' },
      ['163', 'wangyiyun'],
    );
    api.site({ id: 'netease', name: '网易云', hosts: /(^|\.)(163\.com|126\.net|163cn\.tv)$/, prewarm: ['https://interface3.music.163.com/', 'https://music.163.com/'] });
    api.provide(MUSIC_PROVIDERS, { ...netease, site: 'netease', defaultSearch: true, exactRank: 0, lyricsFallback: true, account: { loggedIn: () => !!new CookieJar(loadConfig().cookies.netease).get('MUSIC_U') } });
  },
};
