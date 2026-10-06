import { loadConfig, type SalviaModule } from '@salvia/core';
import { ANIME_SOURCES } from '@salvia/anime';
import { AUDIO_MATCHERS, MUSIC_PROVIDERS } from '@salvia/music';
import { VIDEO_SOURCES } from '@salvia/video';
import { bilibiliAnime } from './anime.ts';
import { biliClient } from './client.ts';
import { bilibiliMatcher, bilibiliMusic } from './music.ts';
import { biliInfo, biliListing, bilibiliSearch } from './video.ts';

/** B站：视频、番剧、音频。 */
export const bilibiliModule: SalviaModule = {
  id: 'bilibili',
  setup(api) {
    // 音频区 (au / am) are songs; everything else on bilibili.com opens as video.
    api.host({ pattern: /(^|\.)bilibili\.com$/i, path: /^\/audio\//, kind: 'music', site: 'bilibili' });
    api.host({ pattern: /(^|\.)bilibili\.com$/i, kind: 'video', site: 'bilibili' });
    api.host({ pattern: /(^|\.)(b23\.tv|bili2233\.cn)$/i, kind: 'video', site: 'bilibili' });
    // BV / av ids work typed alone; with @parse:bilibili plain digits are an av id.
    api.id({ pattern: /^(BV[0-9A-Za-z]{10}|av\d+)$/i, kind: 'video', site: 'bilibili', link: (id) => id, platform: 'bilibili', bare: -2, label: 'BV/av号' });
    api.id({ pattern: /^\d+$/, kind: 'video', site: 'bilibili', link: (id) => `av${id}`, platform: 'bilibili' });
    // 番剧 ep / ss / md and 音频区 au / am ids are unambiguous: they work typed alone too.
    api.id({ pattern: /^(ep|ss)\d+$/i, kind: 'video', site: 'bilibili', link: (id) => `https://www.bilibili.com/bangumi/play/${id.toLowerCase()}`, platform: 'bilibili', bare: -2, label: '番剧 ep/ss号' });
    api.id({ pattern: /^md\d+$/i, kind: 'video', site: 'bilibili', link: (id) => `https://www.bilibili.com/bangumi/media/${id.toLowerCase()}`, platform: 'bilibili', bare: -2 });
    api.id({ pattern: /^(au|am)\d+$/i, kind: 'music', site: 'bilibili', link: (id) => `https://www.bilibili.com/audio/${id.toLowerCase()}`, platform: 'bilibili', bare: -2, label: 'B站音频 au号' });
    api.platform({ type: 'video', id: 'bilibili', name: 'B站', aliases: ['bili', 'b站'] });
    api.platform({ type: 'music', id: 'bilibili', name: 'B站', aliases: ['bili', 'b站'] });
    api.login(
      'bilibili',
      { name: 'B站', cookie: 'bili', url: 'https://passport.bilibili.com/login', domains: ['bilibili.com'], needs: ['SESSDATA'], done: '可以下载 1080P 了（更高画质需要大会员）' },
      ['bili', 'b站'],
    );
    api.site({
      id: 'bili',
      name: 'B站',
      hosts: /(^|\.)(bilibili\.com|hdslb\.com|bilivideo\.(com|cn)|b23\.tv|biliapi\.net)$/,
      probe: 'https://api.bilibili.com/x/web-interface/zone',
      prewarm: ['https://api.bilibili.com/'],
    });
    api.provide(VIDEO_SOURCES, {
      id: 'bilibili',
      name: 'B站',
      site: 'bili',
      list: biliListing,
      search: bilibiliSearch,
      link: (id) => `https://www.bilibili.com/video/${id}`,
      info: (hit, signal) => biliInfo(hit.id, signal),
      // A login changes which qualities are served (1080P …).
      cacheKey: () => loadConfig().cookies.bili ?? '',
    });
    api.provide(MUSIC_PROVIDERS, bilibiliMusic);
    api.provide(AUDIO_MATCHERS, bilibiliMatcher);
    api.provide(ANIME_SOURCES, bilibiliAnime);
    // Device cookies and signing keys before the first search.
    api.warm(() => biliClient().warm());
  },
};
