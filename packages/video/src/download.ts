import { join } from 'node:path';
import { formatBytes, safeName, type Context, type PickItem } from '@salvia/core';
import { downloadFormat } from './dash.ts';
import { estimateSize, formatDuration, type Entry, type Format, type Listing, type Resolved } from './model.ts';
import { videoSource, type VideoSource } from './sources.ts';

/** Stream URLs expire after a few hours; reuse a resolve only briefly. */
const FRESH_MS = 5 * 60 * 1000;
const cache = new Map<string, { res: Resolved; at: number }>();

/** A new login (B站 1080P) must not get the qualities resolved before it. */
const cacheKey = (source: VideoSource | undefined, entry: Entry) => `${entry.id}|${source?.cacheKey?.() ?? ''}`;

async function resolveFresh(source: VideoSource | undefined, entry: Entry, signal?: AbortSignal): Promise<Resolved> {
  const key = cacheKey(source, entry);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.res;
  const res = await entry.resolve(signal);
  cache.set(key, { res, at: Date.now() });
  return res;
}

export type Choice = string | 'best' | 'audio';

function chooseFormat(formats: Format[], choice: Choice): Format | undefined {
  if (choice === 'best') return formats.find((f) => f.video) ?? formats[0];
  if (choice === 'audio') return formats.find((f) => f.id === 'audio') ?? formats.find((f) => !f.video);
  return formats.find((f) => f.id === choice);
}

/** Download one entry of a video source in the chosen format. */
export function enqueueVideo(ctx: Context, sourceId: string, entry: Entry, choice: Choice, label: string, title = entry.title): void {
  const source = videoSource(sourceId);
  ctx.enqueue({
    kind: 'video',
    title: `${title} · ${label}`,
    host: sourceId,
    async run(signal, report) {
      const res = await resolveFresh(source, entry, signal);
      const format = chooseFormat(res.formats, choice) ?? res.formats[0];
      if (!format) throw new Error('没有可用的格式。');
      const out = join(ctx.config.downloadDir, `${safeName(res.title)}.${format.ext}`);
      try {
        return await downloadFormat(res, format, out, { signal, report, chunkSize: source?.chunk });
      } catch (err) {
        cache.delete(cacheKey(source, entry)); // a retry should re-resolve, URLs may have expired
        throw err;
      }
    },
  });
}

async function showFormats(ctx: Context, sourceId: string, listing: Listing, index: number): Promise<void> {
  const entry = listing.entries[index]!;
  ctx.status(`解析 ${entry.title}`);
  const res = await resolveFresh(videoSource(sourceId), entry, ctx.signal);
  const many = listing.entries.length > 1;
  const head = [res.title, res.uploader, formatDuration(res.duration)].filter(Boolean).join(' · ');
  ctx.status(many ? `${head}（${index + 1}/${listing.entries.length}）` : head, 'idle');

  const items: PickItem[] = res.formats.map((f) => {
    const size = estimateSize(f, res.duration);
    return {
      id: `f:${f.id}`,
      title: f.label,
      meta: size ? `约 ${formatBytes(size)}` : undefined,
      pick: () => {
        enqueueVideo(ctx, sourceId, entry, f.id, f.label, res.title);
        ctx.status(`已加入下载：${f.label}`, 'ok');
      },
    };
  });

  // Hidden by default in the UIs; picking one offers to log in.
  for (const l of res.locked ?? []) {
    items.push({ id: `locked:${l.label}`, title: l.label, meta: l.reason === '登录后可下载' ? undefined : l.reason, locked: { reason: l.reason, site: l.site } });
  }

  if (many) {
    items.push(...allItems(ctx, sourceId, listing), {
      id: 'list',
      title: `选择其他（共 ${listing.entries.length} 个）…`,
      pick: () => showEntries(ctx, sourceId, listing),
    });
  }
  ctx.items(items);
}

function allItems(ctx: Context, sourceId: string, listing: Listing): PickItem[] {
  const n = listing.entries.length;
  const all = (choice: Choice, label: string): PickItem => ({
    id: `all:${choice}`,
    title: `全部 ${n} 个 · ${label}`,
    pick: () => {
      for (const e of listing.entries) enqueueVideo(ctx, sourceId, e, choice, label);
      ctx.status(`已加入 ${n} 个下载`, 'ok');
    },
  });
  return [all('best', '最佳画质'), all('audio', '仅音频')];
}

function showEntries(ctx: Context, sourceId: string, listing: Listing): void {
  const head = [listing.title, listing.uploader, `${listing.entries.length} 个`].filter(Boolean).join(' · ');
  ctx.status(head, 'idle');
  ctx.items([
    ...allItems(ctx, sourceId, listing),
    ...listing.entries.map((e, i) => ({
      id: `e:${i}`,
      title: e.title,
      meta: [e.badge, e.duration ? formatDuration(e.duration) : ''].filter(Boolean).join(' · ') || undefined,
      pick: () => showFormats(ctx, sourceId, listing, i),
    })),
  ]);
}

/**
 * Open a link with a video source: its own flow when it has one, else its entries (or straight to
 * the formats of a single / pinned one). Other features use this too (B站 番剧 from @anime).
 */
export async function openVideoLink(ctx: Context, sourceId: string, url: string): Promise<void> {
  const source = videoSource(sourceId);
  if (!source) return ctx.status('暂不支持这个链接。', 'error');
  if (source.open) return source.open(ctx, url);
  if (!source.list) return ctx.status('暂不支持这个链接。', 'error');
  ctx.status(`解析${source.name}链接`);
  const listing = await source.list(url, ctx.signal);
  if (!listing.entries.length) return ctx.status('列表是空的。', 'error');
  if (listing.entries.length > 1 && !listing.pinned) showEntries(ctx, sourceId, listing);
  else await showFormats(ctx, sourceId, listing, listing.current);
}
