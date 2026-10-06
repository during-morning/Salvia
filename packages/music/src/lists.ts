import { formatDuration, getSetting, type Context, type PickItem } from '@salvia/core';
import { enqueueDirect, outDir, type Choice } from './download.ts';
import { norm } from './exact.ts';
import { enqueueAudioOf, enqueueMatchOnly, accountProviders } from './matching.ts';
import { artistLine, type Track, type TrackList } from './model.ts';
import { trackPreview } from './preview.ts';
import { matchOnly, providerOf } from './providers.ts';
import { showTrack } from './track.ts';

const VERSION = /(版|翻唱|cover|dj|remix|伴奏|live|钢琴|吉他|女声|男声|纯音乐|instrumental|karaoke|8d|加速|降调|片段|铃声)/i;

/**
 * Search results, originals first: releases on music platforms, then uploads found on video
 * sites, then what can't be obtained. Within each: exact titles before partial ones, covers / DJ /
 * 伴奏 versions later, and artists other results name as 原唱 ahead.
 */
export function rankSearch(tracks: Track[], query: string): Track[] {
  const q = norm(query);
  const versionWanted = VERSION.test(query);
  const mentions = (artist: string) =>
    artist ? tracks.filter((o) => !o.artists.includes(artist) && `${o.title} ${o.album ?? ''}`.includes(artist)).length : 0;
  const score = (t: Track) => {
    const title = norm(t.title);
    const withArtist = t.artists.some((a) => q.includes(norm(a)));
    let s = title === q || (withArtist && q.includes(title)) ? -3 : title.includes(q) || q.includes(title) ? -1 : 0;
    if (VERSION.test(t.title) && !versionWanted) s += 2;
    s -= Math.min(2, Math.max(0, ...t.artists.map(mentions)));
    return s;
  };
  const tier = (t: Track) => (t.playable === false ? 2 : providerOf(t.source)?.video ? 1 : 0);
  return tracks
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => tier(a.t) - tier(b.t) || a.s - b.s || a.i - b.i)
    .map((x) => x.t);
}

const MUSIC_COLUMNS = [
  { title: '歌名', flex: 3 },
  { title: '歌手', flex: 2 },
  { title: '专辑', flex: 2 },
  { title: '时长', width: 6, align: 'right' as const },
  { title: '来源', width: 11 },
];

function trackMeta(t: Track, withSource = false): string {
  const parts = [artistLine(t), t.album];
  if (withSource) parts.push(providerOf(t.source)?.name);
  return parts.filter(Boolean).join(' · ');
}

/** Download each track the way its platform needs (own files, a video's audio, or a match). */
function enqueueTracks(ctx: Context, tracks: Track[], choice: Choice, dir: string): void {
  for (const t of tracks) {
    if (matchOnly(t)) enqueueMatchOnly(ctx, t, choice === 'm4a' ? 'm4a' : 'mp3', dir);
    else if (providerOf(t.source)?.fetchAudio) enqueueAudioOf(ctx, t, choice, dir);
    else enqueueDirect(ctx, t, choice, dir);
  }
  ctx.status(`已加入 ${tracks.length} 个下载`, 'ok');
}

export function showList(ctx: Context, list: TrackList, withSource = false): void {
  const n = list.tracks.length;
  const usable = list.tracks.filter((t) => t.playable !== false);
  const dir = outDir(ctx, list);
  const metadataOnly = n > 0 && list.tracks.every(matchOnly);
  const all = (choice: Choice, label: string): PickItem => ({
    id: `all:${choice}`,
    title: `全部 ${usable.length} 首 · ${label}`,
    pick: () => enqueueTracks(ctx, usable, choice, dir),
  });
  const skipped = n - usable.length;
  const accounts = accountProviders().map((p) => p.name);
  const via = accounts.length ? `音频来自你登录的${accounts.join(' / ')}，找不到时用视频网站匹配` : '音频来自视频网站匹配';
  ctx.status([list.title, `${n} 首`, skipped ? `${skipped} 首需登录` : '', metadataOnly ? via : ''].filter(Boolean).join(' · '), 'idle');
  ctx.items(
    [
      ...(n > 1 && usable.length && list.kind !== 'track'
        ? metadataOnly
          ? [all('mp3', 'mp3'), all('m4a', 'm4a')]
          : [all('best', '最高音质'), all('mp3', 'mp3')]
        : []),
      ...list.tracks.map((t, i) => ({
        id: `t:${i}`,
        title: t.title,
        meta: trackMeta(t, withSource),
        cells: [t.title, artistLine(t), t.album ?? '', t.duration ? formatDuration(t.duration) : '', providerOf(t.source)?.name ?? t.source],
        selectable: t.playable !== false,
        locked: t.playable === false ? { reason: String(t.extra?.locked ?? '需要会员，或当前网络所在地区不可用'), site: t.source } : undefined,
        pick: () => showTrack(ctx, t, list.kind === 'track' ? undefined : list),
        previewer: (signal: AbortSignal) => trackPreview(t, signal),
      })),
    ],
    {
      columns: MUSIC_COLUMNS,
      // Checked songs at the batch quality (@setting musicQuality).
      batch: {
        label: '下载选中',
        run: (ids) =>
          enqueueTracks(
            ctx,
            ids.map((id) => list.tracks[Number(id.slice(2))]!).filter(Boolean),
            getSetting('musicQuality') === 'mp3' ? 'mp3' : 'best',
            dir,
          ),
      },
    },
  );
}
