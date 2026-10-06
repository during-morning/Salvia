import type { AnimeSource, CatalogEntry } from '@salvia/anime';
import { openVideoLink } from '@salvia/video';
import { biliClient } from './client.ts';

const clean = (s?: string) => (s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

/** B站's 番剧 and 影视 seasons for a keyword (empty outside the regions it licenses them to). */
export async function biliSeasons(keyword: string, signal?: AbortSignal): Promise<CatalogEntry[]> {
  type R = { season_id: number; title: string; org_title?: string; ep_size?: number; media_score?: { score?: number }; season_type_name?: string; pubtime?: number };
  const kinds = await Promise.all(
    ['media_bangumi', 'media_ft'].map((search_type) =>
      biliClient()
        .api<{ result?: R[] }>('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type, keyword, page: 1 }, signal)
        .then((r) => r.result ?? [])
        .catch(() => [] as R[]),
    ),
  );
  return kinds.flat().map((r) => ({
    source: 'bilibili',
    id: String(r.season_id),
    title: clean(r.title),
    original: clean(r.org_title) || undefined,
    episodes: r.ep_size || undefined,
    score: r.media_score?.score || undefined,
    type: r.season_type_name,
    year: r.pubtime ? new Date(r.pubtime * 1000).getFullYear().toString() : undefined,
  }));
}

/** B站 番剧: the official season, downloaded with the user's own account (大会员 for members-only episodes). */
export const bilibiliAnime: AnimeSource = {
  id: 'bilibili',
  name: 'B站',
  aliases: ['bili', 'b站'],
  official: true,
  catalog: biliSeasons,
  async offers(title, ctx) {
    const seasons = title.entries.filter((e) => e.source === 'bilibili');
    if (!seasons.length) return undefined;
    return {
      summary: 'B站有正版',
      items: seasons.map((e) => ({
        id: e.id,
        title: `B站正版 · ${e.title}${e.episodes ? ` · ${e.episodes} 集` : ''}`,
        meta: '用自己的账号 / 大会员',
        pick: () => openVideoLink(ctx, 'bilibili', `https://www.bilibili.com/bangumi/play/ss${e.id}`),
      })),
    };
  },
};
