import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FatalError, proxiedFetch, type Progress } from '@salvia/core';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import type { BtResource } from './sources.ts';

/**
 * Salvia's BitTorrent client (WebTorrent: TCP peers, DHT, trackers, web seeds; no WebRTC). A
 * torrent is dropped as soon as its files are complete, so Salvia doesn't keep seeding — while
 * downloading, BitTorrent shares pieces with the swarm as any client does.
 */

let client: Promise<WebTorrent> | undefined;

function btClient(): Promise<WebTorrent> {
  client ??= import('webtorrent').then(({ default: WT }) => {
    const c = new WT({ utp: false, webSeeds: true });
    c.on('error', () => {});
    process.once('exit', () => c.destroy());
    return c;
  });
  return client;
}

/** The .torrent file when an index offers one (instant metadata), else the magnet link. */
async function sourceOf(r: Pick<BtResource, 'torrent' | 'magnet'>, signal?: AbortSignal): Promise<string | Uint8Array> {
  if (r.torrent) {
    try {
      const res = await proxiedFetch(r.torrent, { signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      // fall back to the magnet
    }
  }
  if (r.magnet) return r.magnet;
  throw new FatalError('这个资源没有磁力链接或种子文件。');
}

async function existing(c: WebTorrent, hash?: string): Promise<Torrent | null> {
  return hash ? ((await c.get(hash)) ?? null) : null;
}

/**
 * Public HTTP(S) trackers added to every torrent: magnet links often carry none, and where UDP is
 * blocked (DHT, udp:// trackers) these still find peers over TCP.
 */
const TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.opentrackr.org:443/announce',
  'http://open.acgnxtracker.com:80/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.bt4g.com:2095/announce',
];

function add(c: WebTorrent, src: string | Uint8Array, path: string): Torrent {
  return c.add(src, { path, deselect: true, announce: TRACKERS });
}

function whenReady(t: Torrent, signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (t.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new FatalError('找不到这个资源的下载源：没有人在分享，或当前网络屏蔽了 BT（DHT / Tracker）。')), ms);
    const done = (err?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => done(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    t.once('ready', () => done());
    t.once('error', (err: unknown) => done(new FatalError(`BT：${err instanceof Error ? err.message : String(err)}`)));
  });
}

const stop = (t: Torrent) => new Promise<void>((r) => t.destroy({ destroyStore: false }, () => r()));

export interface BtFile {
  index: number;
  name: string;
  path: string;
  length: number;
}

/** The files a release contains (needs its metadata: instant from a .torrent, from peers for a magnet). */
export async function btFiles(r: BtResource, dir: string, signal?: AbortSignal): Promise<{ name: string; files: BtFile[] }> {
  const c = await btClient();
  const src = await sourceOf(r, signal);
  const t = (await existing(c, r.hash)) ?? add(c, src, dir);
  try {
    await whenReady(t, signal, 90_000);
    return { name: t.name, files: t.files.map((f, index) => ({ index, name: f.name, path: f.path, length: f.length })) };
  } finally {
    // Nothing was selected; the download job adds it again with its files.
    await stop(t);
  }
}

/** Download some (or all) files of a release into `dir`; resolves to the file, or the release's folder. */
export async function btDownload(r: BtResource, dir: string, files: number[] | 'all', signal: AbortSignal, report: (p: Progress) => void): Promise<string> {
  const c = await btClient();
  const src = await sourceOf(r, signal);
  const prev = await existing(c, r.hash);
  if (prev) await stop(prev);
  const t = add(c, src, dir);
  try {
    report({ progress: -1 });
    await whenReady(t, signal, 120_000);
    const chosen = files === 'all' ? t.files : files.map((i) => t.files[i]).filter((f) => !!f);
    if (!chosen.length) throw new FatalError('种子里没有选中的文件。');
    for (const f of chosen) f.select();
    const total = chosen.reduce((a, f) => a + f.length, 0);
    // Existing pieces on disk are verified first, so a paused download continues.
    await new Promise<void>((resolve, reject) => {
      const tick = setInterval(() => {
        const done = chosen.reduce((a, f) => a + Math.min(f.length, f.downloaded), 0);
        report({ progress: total ? done / total : -1, speed: t.downloadSpeed });
        if (chosen.every((f) => f.progress >= 1 || f.downloaded >= f.length)) finish();
      }, 1000);
      const finish = (err?: unknown) => {
        clearInterval(tick);
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => finish(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      t.on('error', (err: unknown) => finish(new FatalError(`BT：${err instanceof Error ? err.message : String(err)}`)));
    });
    // Pieces span file boundaries, so bits of unchosen neighbours were written too: drop those.
    await Promise.all(t.files.filter((f) => !chosen.includes(f) && f.progress < 1).map((f) => rm(join(dir, f.path), { force: true }).catch(() => {})));
    return chosen.length === 1 ? join(dir, chosen[0]!.path) : join(dir, t.name);
  } finally {
    // Done, paused or failed: leave the swarm (no seeding afterwards).
    await stop(t);
  }
}
