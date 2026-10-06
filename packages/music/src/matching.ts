import { FatalError, getSetting, unreachable, type Context, type Progress } from '@salvia/core';
import type { AudioFormat } from '@salvia/media';
import { downloadDirect, enqueueDirect, qualityItems, type Choice } from './download.ts';
import { exactMatch } from './exact.ts';
import { acceptable, confident, rank, type Scored } from './match.ts';
import { artistLine, type AudioMatcher, type Quality, type Track } from './model.ts';
import { enrich, matchers, providerOf, providers, reachableProvider } from './providers.ts';

/**
 * Audio for metadata-only platforms (Spotify, Apple Music, 汽水), in order: the same song on the
 * user's own account elsewhere, a match on a video site (the registered AudioMatchers: YouTube,
 * B站 …), then the same song (title + artists identical) on another music platform.
 */

type Match = Scored & { matcher: AudioMatcher };
export type MatchPick = { matcher: string; id: string };

/** The video site matches come from: the @setting choice, else the first reachable one. Empty for "exact only". */
export function matchSites(): AudioMatcher[] {
  const pref = getSetting('matchSource');
  if (pref === 'exact') return [];
  const all = [...matchers()].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const ok = all.filter((m) => !m.site || !unreachable(m.site));
  const chosen = all.find((m) => m.id === pref);
  if (chosen && ok.includes(chosen)) return [chosen];
  return ok.slice(0, 1);
}

async function candidates(t: Track, m: AudioMatcher, signal?: AbortSignal): Promise<Match[]> {
  const list = await m.candidates(t, signal).catch(() => []);
  return rank(t, list).map((s) => ({ ...s, matcher: m }));
}

/** Logged-in accounts on platforms that have them (网易云 / QQ音乐 …). */
export const accountProviders = () => providers().filter((p) => p.account?.loggedIn() && p.qualities && reachableProvider(p));

/** The same song on the user's own account elsewhere, with a downloadable quality. */
export async function accountMatch(t: Track, signal?: AbortSignal): Promise<{ track: Track; score: number; qualities: Quality[] } | undefined> {
  for (const provider of accountProviders()) {
    const hits = await provider.search(`${t.title} ${t.artists[0] ?? ''}`, signal).catch(() => [] as Track[]);
    const ranked = rank(
      t,
      hits.map((h) => ({ id: h.id, title: h.title, channel: artistLine(h), duration: h.duration })),
    ).filter((s) => confident(s, t));
    for (const s of ranked.slice(0, 2)) {
      const track = hits.find((h) => h.id === s.candidate.id)!;
      const qualities = (await provider.qualities!(track, signal).catch(() => [] as Quality[])).filter((q) => !q.trial);
      if (qualities.length) return { track, score: s.score, qualities };
    }
  }
  return undefined;
}

/**
 * The audio of a matched video. A chosen one is used as is; otherwise the good matches in rank
 * order (the top hit can be region-locked while the next upload is fine), then an exact match.
 */
async function downloadMatched(t: Track, format: 'm4a' | 'mp3', dir: string, picks: MatchPick[] | undefined, signal: AbortSignal, report: (p: Progress) => void): Promise<string> {
  const meta = await enrich(t, signal);
  let order: MatchPick[] = picks ?? [];
  if (!order.length) {
    for (const m of matchSites()) {
      const good = (await candidates(t, m, signal)).filter((s) => acceptable(s, t)).slice(0, 4);
      order = good.map((s) => ({ matcher: m.id, id: s.candidate.id }));
      if (order.length) break;
    }
  }
  let lastError: unknown;
  for (const p of order) {
    const m = matchers().find((x) => x.id === p.matcher);
    if (!m) continue;
    try {
      const video: Track = { id: p.id, source: m.provider, title: meta.title, artists: meta.artists };
      return await downloadDirect(video, 'best', dir, signal, report, meta, format);
    } catch (err) {
      if (signal.aborted) throw err;
      lastError = err;
    }
  }
  if (!picks?.length) {
    const hit = await exactMatch(meta);
    if (hit) return downloadDirect(hit.track, format === 'mp3' ? 'mp3' : 'best', dir, signal, report, meta);
  }
  if (lastError) throw lastError;
  const where = matchSites().map((s) => s.name).join('、');
  throw new FatalError(`${where ? `${where}上没有找到这首歌的匹配，` : ''}其他音乐平台也没有歌名和歌手完全一致的版本。可以单独打开这首歌手动选择。`);
}

/** Download a track's audio from a match (picks: chosen candidates; none: the best ones). */
export function enqueueMatched(ctx: Context, t: Track, format: 'm4a' | 'mp3', dir: string, picks?: MatchPick[]): void {
  ctx.enqueue({
    kind: 'music',
    title: `${artistLine(t)} - ${t.title}`,
    host: picks?.[0]?.matcher ?? matchSites()[0]?.id ?? t.source,
    run: (signal, report) => downloadMatched(t, format, dir, picks, signal, report),
  });
}

/** Metadata-only tracks in a batch: the user's own account first when logged in, then a match. */
export function enqueueMatchOnly(ctx: Context, t: Track, format: 'm4a' | 'mp3', dir: string): void {
  ctx.enqueue({
    kind: 'music',
    title: `${artistLine(t)} - ${t.title}`,
    host: t.source,
    async run(signal, report) {
      const hit = await accountMatch(t, signal);
      if (hit) return downloadDirect(hit.track, format === 'mp3' ? 'mp3' : 'best', dir, signal, report, await enrich(t, signal));
      return downloadMatched(t, format, dir, undefined, signal, report);
    },
  });
}

/** A track whose provider fetches its own audio (a video's audio track): download as mp3 / m4a. */
export function enqueueAudioOf(ctx: Context, t: Track, choice: Choice, dir: string): void {
  const as: AudioFormat = choice === 'm4a' ? 'm4a' : 'mp3';
  enqueueDirect(ctx, t, 'best', dir, undefined, as);
}

/** spotDL-style choice: the best video match per format, then the candidates, then exact matches on music platforms. */
export async function showMatches(ctx: Context, t: Track, dir: string): Promise<void> {
  const sites = matchSites();
  const head = [t.title, artistLine(t), t.album].filter(Boolean).join(' · ');
  let site: AudioMatcher | undefined;
  let ranked: Match[] = [];
  for (const s of sites) {
    ctx.status(`在 ${s.name} 上匹配 ${t.title}`);
    ranked = (await candidates(t, s, ctx.signal)).slice(0, 5);
    if (ranked.length) {
      site = s;
      break;
    }
  }
  const sure = ranked.length > 0 && (confident(ranked[0], t) || acceptable(ranked[0], t));
  // No good video match: the same song on a music platform.
  const exact = sure ? undefined : await (ctx.status(`在其他音乐平台查找 ${t.title}（歌名和歌手完全一致）`), exactMatch(t));
  if (!ranked.length && !exact) {
    return ctx.status(`${sites.length ? `${sites.map((s) => s.name).join('、')}上没有找到这首歌，` : ''}其他音乐平台也没有歌名和歌手完全一致的版本。`, 'error');
  }
  const source = exact ? providerOf(exact.track.source)!.name : site!.name;
  const skipped = matchers().filter((m) => m.site && unreachable(m.site) && m !== site);
  const why = skipped.length ? `，${skipped.map((m) => m.name).join('、')} 当前网络无法访问` : '';
  ctx.status(`${head}（${providerOf(t.source)?.name ?? '这个平台'}只提供歌曲信息，音频来自 ${source}${why}）`, 'idle');
  const meta = exact ? await enrich(t, ctx.signal) : t;
  ctx.items([
    ...(exact
      ? qualityItems(ctx, exact.track, exact.qualities, dir, meta).map((i) => ({ ...i, meta: [i.meta, `${providerOf(exact.track.source)!.name} · 完全一致`].filter(Boolean).join(' · ') }))
      : []),
    // MP3 first (what most players expect); m4a keeps the video's AAC untouched.
    ...(ranked.length
      ? (['mp3', 'm4a'] as const).map((fmt) => ({
          id: `best:${fmt}`,
          title: `最佳匹配 · ${fmt}`,
          meta: `${ranked[0]!.candidate.title} · ${site!.name} ${Math.round(ranked[0]!.score)}%`,
          disabled: !sure,
          pick: () => {
            // Best first, then the next good matches as fallbacks.
            const picks = [ranked[0]!, ...ranked.slice(1).filter((s) => acceptable(s, t))].map((s) => ({ matcher: s.matcher.id, id: s.candidate.id }));
            enqueueMatched(ctx, t, fmt, dir, picks);
            ctx.status('已加入下载', 'ok');
          },
        }))
      : []),
    ...ranked.map((s) => ({
      id: `${s.matcher.id}:${s.candidate.id}`,
      title: s.candidate.title,
      meta: `${s.candidate.channel} · ${s.matcher.name} · 匹配 ${Math.round(s.score)}%`,
      pick: () => {
        enqueueMatched(ctx, t, 'mp3', dir, [{ matcher: s.matcher.id, id: s.candidate.id }]);
        ctx.status('已加入下载', 'ok');
      },
    })),
  ]);
}
