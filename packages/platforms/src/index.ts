import type { SalviaModule } from '@salvia/core';
import { bilibiliModule } from './bilibili/module.ts';
import { youtubeModule } from './youtube/module.ts';
import { neteaseModule } from './netease/module.ts';
import { qqModule } from './qq/module.ts';
import { spotifyModule } from './spotify/module.ts';
import { fivesingModule } from './fivesing/module.ts';
import { kugouModule } from './kugou/module.ts';
import { kuwoModule } from './kuwo/module.ts';
import { miguModule } from './migu/module.ts';
import { qianqianModule } from './qianqian/module.ts';
import { jamendoModule } from './jamendo/module.ts';
import { jooxModule } from './joox/module.ts';
import { sodaModule } from './soda/module.ts';
import { appleModule } from './apple/module.ts';
import { douyinModule } from './douyin/module.ts';
import { btModule } from './bt/module.ts';

/**
 * Every platform, in install order. Order matters where hosts overlap: the first matching host
 * rule wins (5sing before 酷狗, 汽水 before 抖音), and @music: completion lists platforms in it.
 */
export const platformModules: SalviaModule[] = [
  neteaseModule,
  qqModule,
  spotifyModule,
  fivesingModule,
  kugouModule,
  kuwoModule,
  miguModule,
  qianqianModule,
  sodaModule,
  appleModule,
  jamendoModule,
  jooxModule,
  bilibiliModule,
  youtubeModule,
  douyinModule,
  btModule,
];
