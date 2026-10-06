import { FatalError } from '@salvia/core';
import type { Entry, Listing, Resolved } from '@salvia/video';
import { biliClient } from './client.ts';
import { fromPlay, type PlayData } from './video.ts';

/**
 * B站 番剧 / 国创 / 电影 (pgc): seasons and episodes from the official catalogue. Episodes play
 * with the user's own login; members-only ones need their own 大会员, and most seasons are
 * licensed for mainland China only (use @proxy bili with a mainland exit elsewhere).
 */

export interface BangumiRef {
  ep?: number;
  ss?: number;
  md?: number;
}

export function parseBangumi(input: string): BangumiRef | undefined {
  const ep = input.match(/bangumi\/play\/ep(\d+)/)?.[1] ?? input.match(/^ep(\d+)$/i)?.[1];
  if (ep) return { ep: Number(ep) };
  const ss = input.match(/bangumi\/play\/ss(\d+)/)?.[1] ?? input.match(/^ss(\d+)$/i)?.[1];
  if (ss) return { ss: Number(ss) };
  const md = input.match(/bangumi\/media\/md(\d+)/)?.[1] ?? input.match(/^md(\d+)$/i)?.[1];
  if (md) return { md: Number(md) };
  return undefined;
}

interface Episode {
  id: number;
  aid: number;
  bvid?: string;
  cid: number;
  /** "1", "2" … or a name for specials */
  title: string;
  long_title?: string;
  /** ms */
  duration?: number;
  badge?: string;
  cover?: string;
}

export interface Season {
  season_id: number;
  title: string;
  cover?: string;
  evaluate?: string;
  rating?: { score?: number; count?: number };
  publish?: { pub_time?: string; is_finish?: number };
  areas?: { name: string }[];
  styles?: string[];
  stat?: { views?: number; favorites?: number; danmakus?: number };
  episodes: Episode[];
  section?: { title: string; episodes: Episode[] }[];
  up_info?: { uname?: string };
}

export async function seasonInfo(ref: BangumiRef, signal?: AbortSignal): Promise<Season> {
  const client = biliClient();
  let ss = ref.ss;
  if (ref.md) {
    const r = await client.api<{ media?: { season_id?: number } }>('https://api.bilibili.com/pgc/review/user', { media_id: ref.md }, signal);
    ss = r.media?.season_id;
    if (!ss) throw new FatalError('没有找到这部番剧。');
  }
  return client.api<Season>('https://api.bilibili.com/pgc/view/web/season', ref.ep ? { ep_id: ref.ep } : { season_id: ss! }, signal);
}

const epName = (e: Episode) => `${/^\d+(\.\d+)?$/.test(e.title) ? `第${e.title}话` : e.title}${e.long_title ? ` ${e.long_title}` : ''}`;

async function resolveEpisode(e: Episode, season: Season, signal?: AbortSignal): Promise<Resolved> {
  const play = await biliClient().api<PlayData>(
    'https://api.bilibili.com/pgc/player/web/playurl',
    { ep_id: e.id, cid: e.cid, qn: 0, fnval: 4048, fnver: 0, fourk: 1 },
    signal,
  );
  if (play.is_preview) throw new FatalError(`${epName(e)}是会员内容：当前账号只能试看几分钟。用自己的大会员账号 @login bilibili 后可下载。`);
  return fromPlay(play, `${season.title} ${epName(e)}`, season.up_info?.uname ?? 'B站番剧', e.cover ?? season.cover);
}

export async function bangumiListing(input: string, signal?: AbortSignal): Promise<Listing> {
  const ref = parseBangumi(input);
  if (!ref) throw new FatalError('没有识别出 B站番剧链接（ep / ss / md 编号）。');
  const season = await seasonInfo(ref, signal);
  const entries = season.episodes.map<Entry>((e) => ({
    id: `ep${e.id}`,
    title: epName(e),
    duration: e.duration ? Math.round(e.duration / 1000) : undefined,
    badge: e.badge || undefined,
    resolve: (s) => resolveEpisode(e, season, s),
  }));
  if (!entries.length) throw new FatalError('这部番剧还没有可播放的剧集。');
  const at = ref.ep ? season.episodes.findIndex((e) => e.id === ref.ep) : -1;
  return { title: season.title, uploader: season.up_info?.uname, entries, current: Math.max(0, at), pinned: at >= 0 };
}
