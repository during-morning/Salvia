import { join } from 'node:path';
import { FatalError, formatBytes, safeName, template, type Context, type PickItem, type Progress } from '@salvia/core';
import { downloadFile, type AudioFormat } from '@salvia/media';
import { exactMatch } from './exact.ts';
import { findLyrics } from './lyrics.ts';
import { artistLine, type Quality, type Track, type TrackList } from './model.ts';
import { providerOf } from './providers.ts';
import { CODEC, finalize } from './tag.ts';

export type Choice = string | 'best' | 'mp3';

export const UNAVAILABLE = '没有可下载的音源：可能需要会员，或当前网络不在可用地区，其他平台也没有歌名和歌手完全一致的版本。可以 @login 登录自己的账号，或用 @proxy 设置出口。';

export function fileName(t: Track, ext: string): string {
  return `${template('{artist} - {title}', { artist: t.artists.slice(0, 3).join(', '), title: t.title })}.${ext}`;
}

export function outDir(ctx: Context, list?: TrackList): string {
  return list && list.kind !== 'track' ? join(ctx.config.downloadDir, safeName(list.title)) : ctx.config.downloadDir;
}

export function pickQuality(qs: Quality[], choice: Choice): Quality | undefined {
  const usable = qs.filter((q) => !q.trial);
  if (choice === 'best') return usable[0];
  if (choice === 'mp3') return usable.find((q) => q.ext === 'mp3') ?? usable[0];
  return usable.find((q) => q.id === choice);
}

/**
 * Download `t` from its own platform; `meta` (e.g. the Spotify track it was matched for) names and
 * tags the file, `as` converts to another format. When the platform has nothing to offer, the
 * same song (title + artists identical) is taken from another platform.
 */
export async function downloadDirect(
  t: Track,
  choice: Choice,
  dir: string,
  signal: AbortSignal,
  report: (p: Progress) => void,
  meta: Track = t,
  as?: AudioFormat,
): Promise<string> {
  const provider = providerOf(t.source);
  if (!provider) throw new FatalError(`没有平台 ${t.source}。`);
  const tags = (from: Track, lyricsOf: Track) =>
    findLyrics(lyricsOf, signal).then((lyrics) => ({ title: meta.title, artists: meta.artists, album: meta.album ?? from.album, cover: meta.cover ?? from.cover, lyrics }));

  // Audio that isn't one URL (a video's audio stream): the provider fetches it.
  if (provider.fetchAudio) {
    const tmp = join(dir, `${fileName(meta, 'audio')}.download`);
    const got = await provider.fetchAudio(t, tmp, signal, (p) => report({ progress: p.progress >= 0 ? p.progress * 0.9 : -1, speed: p.speed }));
    const ext = (as ?? got.ext) as AudioFormat;
    const out = join(dir, fileName(meta, ext));
    await finalize(tmp, out, ext, await tags(t, meta), { signal, inputCodec: got.codec });
    return out;
  }

  const own = provider.qualities ? await provider.qualities(t, signal).catch((err) => (signal.aborted ? Promise.reject(err) : ([] as Quality[]))) : [];
  let q = pickQuality(own, choice);
  let from = t;
  if (!q && !provider.video) {
    report({ progress: -1 });
    const hit = await exactMatch(meta);
    if (hit) {
      from = hit.track;
      q = pickQuality(hit.qualities, choice);
    }
  }
  if (!q) throw new FatalError(UNAVAILABLE);
  const ext: AudioFormat = as ?? q.ext;
  const out = join(dir, fileName(meta, ext));
  const tmp = `${out}.download`;
  await downloadFile(q.url, tmp, {
    signal,
    headers: providerOf(from.source)?.headers,
    size: q.approxSize ? undefined : q.size,
    mirrors: q.mirrors,
    onProgress: (done, total, speed) => report({ progress: total ? (done / total) * 0.95 : -1, speed }),
  });
  await finalize(tmp, out, ext, await tags(from, from === t ? t : meta), { signal, inputCodec: ext !== q.ext ? CODEC[q.ext] : undefined });
  return out;
}

export function enqueueDirect(ctx: Context, t: Track, choice: Choice, dir: string, meta?: Track, as?: AudioFormat): void {
  ctx.enqueue({
    kind: 'music',
    title: `${artistLine(meta ?? t)} - ${(meta ?? t).title}`,
    host: t.source,
    run: (signal, report) => downloadDirect(t, choice, dir, signal, report, meta, as),
  });
}

export function qualityItems(ctx: Context, t: Track, qs: Quality[], dir: string, meta?: Track): PickItem[] {
  return qs.map((q) => ({
    id: `q:${q.id}`,
    title: `${q.label} · ${q.ext}`,
    meta: q.size ? formatBytes(q.size) : undefined,
    pick: () => {
      enqueueDirect(ctx, t, q.id, dir, meta);
      ctx.status(`已加入下载：${q.label}`, 'ok');
    },
  }));
}
