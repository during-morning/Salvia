import type { SalviaModule } from '@salvia/core';
import { ANIME_SOURCES } from '@salvia/anime';
import { VIDEO_SOURCES } from '@salvia/video';
import { btAnime, openRelease } from './anime.ts';

/** 动漫 BT 资源：动漫花园、Mikan、ACG.RIP（WebTorrent 下载，完成即停止分享）。 */
export const btModule: SalviaModule = {
  id: 'bt',
  setup(api) {
    api.site({ id: 'bt', name: '动漫 BT 索引', hosts: /(^|\.)(dmhy\.org|mikanani\.me|acg\.rip)$/ });
    // Magnet links, and the indexes' release pages, download through the BT engine.
    api.id({ pattern: /^magnet:\?xt=urn:btih:[0-9a-z]{32,40}/i, kind: 'video', site: 'bt', link: (m) => m, bare: -3, label: '磁力链接' });
    api.host({ pattern: /(^|\.)(dmhy\.org|mikanani\.me|acg\.rip)$/i, kind: 'video', site: 'bt' });
    api.provide(VIDEO_SOURCES, { id: 'bt', name: 'BT', site: 'bt', open: openRelease });
    api.provide(ANIME_SOURCES, btAnime);
  },
};
