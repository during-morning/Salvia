import { formatDuration, type AudioClip, type PreviewData } from '@salvia/core';
import { findLyrics, plainLyrics } from './lyrics.ts';
import { artistLine, type Track } from './model.ts';
import { providerOf } from './providers.ts';

/** A 30-second clip: the platform's own preview, or the lowest quality it serves (a trial clip counts). */
async function clipFor(t: Track, signal: AbortSignal, preview?: string): Promise<AudioClip | undefined> {
  const provider = providerOf(t.source);
  if (!provider) return undefined;
  if (provider.matchOnly) return preview ? { url: preview, duration: 30 } : undefined;
  if (provider.clip) return provider.clip(t, signal);
  if (!provider.qualities) return undefined;
  const qs = await provider.qualities(t, signal);
  const q = qs.find((x) => x.trial) ?? qs[qs.length - 1];
  if (!q) return undefined;
  // Full songs start a little in, where the song has usually begun; trial clips are already cut.
  const start = q.trial || !t.duration ? 0 : Math.min(45, Math.round(t.duration * 0.3));
  return { url: q.url, headers: provider.headers, start, duration: 30 };
}

export async function trackPreview(t: Track, signal: AbortSignal): Promise<PreviewData> {
  const provider = providerOf(t.source)!;
  const own = provider.details ? await provider.details(t, signal).catch(() => undefined) : undefined;
  const [lyrics, intro, clip] = await Promise.all([
    findLyrics(t, signal),
    provider.intro?.(t, signal).catch(() => undefined),
    clipFor(t, signal, String(own?.extra?.preview ?? t.extra?.preview ?? '') || undefined).catch(() => undefined),
  ]);
  const released = intro?.released ?? String(own?.extra?.released ?? t.extra?.released ?? '');
  const fields = [
    { label: '歌手', value: artistLine(t) },
    { label: '专辑', value: t.album ?? own?.album ?? '' },
    { label: '时长', value: t.duration ? formatDuration(t.duration) : '' },
    { label: '发行', value: released },
    { label: '公司', value: intro?.company ?? '' },
    { label: '平台', value: provider.name },
    { label: '状态', value: t.playable === false ? String(t.extra?.locked ?? '需要会员，或当前网络所在地区不可用') : '' },
  ].filter((f) => f.value);
  const sections = [
    ...(lyrics ? [{ title: '歌词', text: plainLyrics(lyrics.lrc) }] : []),
    ...(lyrics?.translation ? [{ title: '翻译', text: plainLyrics(lyrics.translation) }] : []),
    ...(intro?.text ? [{ title: '专辑简介', text: intro.text }] : []),
  ];
  return {
    title: t.title,
    subtitle: artistLine(t),
    fields,
    sections,
    clip,
    note: clip ? undefined : provider.matchOnly ? `${provider.name}没有提供这首歌的试听片段。` : '试听不可用：网站没有给出音源（可能需要会员，或当前网络不在可用地区）。',
  };
}
