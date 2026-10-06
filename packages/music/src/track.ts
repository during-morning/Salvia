import type { Context } from '@salvia/core';
import { UNAVAILABLE, enqueueDirect, outDir, qualityItems } from './download.ts';
import { exactMatch } from './exact.ts';
import { accountMatch, accountProviders, showMatches } from './matching.ts';
import { artistLine, type Quality, type Track, type TrackList } from './model.ts';
import { enrich, providerOf } from './providers.ts';

/** One song opened: its qualities, or for metadata-only platforms its matches. */
export async function showTrack(ctx: Context, t: Track, list?: TrackList): Promise<void> {
  const dir = outDir(ctx, list);
  const head = [t.title, artistLine(t), t.album].filter(Boolean).join(' · ');
  const provider = providerOf(t.source);
  if (!provider) return ctx.status(`没有平台 ${t.source}。`, 'error');

  // A video's audio track (YouTube results): offered as mp3 / m4a.
  if (provider.fetchAudio) {
    ctx.status(`${head}（${provider.name} 视频的音轨）`, 'idle');
    return ctx.items(
      (['mp3', 'm4a'] as const).map((fmt) => ({
        id: `audio:${fmt}`,
        title: `仅音频 · ${fmt}`,
        pick: () => {
          enqueueDirect(ctx, t, 'best', dir, undefined, fmt);
          ctx.status('已加入下载', 'ok');
        },
      })),
    );
  }

  if (provider.matchOnly) {
    // No downloadable audio here. With the user's own account elsewhere, the same song comes
    // from there; otherwise from a video match or another platform.
    if (accountProviders().length) {
      ctx.status(`在你登录的${accountProviders().map((p) => p.name).join(' / ')}上查找 ${t.title}`);
      const hit = await accountMatch(t, ctx.signal);
      if (hit) {
        const meta = await enrich(t, ctx.signal);
        ctx.status(`${head}（音频来自${providerOf(hit.track.source)!.name}，匹配 ${Math.round(hit.score)}%）`, 'idle');
        return ctx.items([...qualityItems(ctx, hit.track, hit.qualities, dir, meta), { id: 'video', title: '改用视频网站匹配…', pick: () => showMatches(ctx, t, dir) }]);
      }
    }
    return showMatches(ctx, t, dir);
  }

  ctx.status(`获取 ${t.title} 的音质`);
  const qs = (
    await (provider.qualities?.(t, ctx.signal) ?? Promise.resolve([] as Quality[])).catch((err) => {
      if (ctx.signal.aborted) throw err;
      return [] as Quality[];
    })
  ).filter((q) => !q.trial);
  if (qs.length) {
    ctx.status(head, 'idle');
    return ctx.items(qualityItems(ctx, t, qs, dir));
  }
  if (provider.video) return ctx.status('这个视频没有可下载的音轨。', 'error');
  // Not obtainable on its own platform (members only, region): the same song elsewhere.
  ctx.status(`${provider.name}无法获取，在其他平台查找歌名和歌手完全一致的版本`);
  const hit = await exactMatch(t);
  if (!hit) return ctx.status(UNAVAILABLE, 'error');
  const name = providerOf(hit.track.source)!.name;
  ctx.status(`${head}（${provider.name}无法获取，音频来自${name}：歌名和歌手完全一致）`, 'idle');
  ctx.items(qualityItems(ctx, hit.track, hit.qualities, dir, t));
}
