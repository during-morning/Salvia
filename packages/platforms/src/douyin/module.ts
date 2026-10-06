import type { SalviaModule } from '@salvia/core';
import { VIDEO_SOURCES } from '@salvia/video';
import { openDouyin } from './open.ts';

/** 抖音：无水印视频、图文、背景音乐、主页作品。 */
export const douyinModule: SalviaModule = {
  id: 'douyin',
  setup(api) {
    // Not qishui.douyin.com (汽水音乐, its own module).
    api.host({ pattern: /^((www|v|m|live)\.)?douyin\.com$/i, kind: 'video', site: 'douyin' });
    api.host({ pattern: /(^|\.)iesdouyin\.com$/i, kind: 'video', site: 'douyin' });
    // A post id (19 digits) works typed alone or with @parse:douyin.
    api.id({ pattern: /^\d{19}$/, kind: 'video', site: 'douyin', link: (id) => `https://www.douyin.com/video/${id}`, bare: -1, label: '抖音作品号' });
    api.login(
      'douyin',
      { name: '抖音', cookie: 'douyin', url: 'https://www.douyin.com/', domains: ['douyin.com'], needs: ['sessionid'], hint: '点右上角"登录"；出现验证时请自己完成' },
      ['dy', '抖音'],
    );
    api.site({ id: 'douyin', name: '抖音', hosts: /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com|douyinpic\.com)$/ });
    // Its own flow: images and music besides the video, creators' pages.
    api.provide(VIDEO_SOURCES, { id: 'douyin', name: '抖音', site: 'douyin', open: openDouyin });
  },
};
