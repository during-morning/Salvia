import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, UA, proxiedFetch, settingNumber } from '@salvia/core';

export interface DownloadOptions {
  headers?: Record<string, string>;
  signal: AbortSignal;
  onProgress?: (done: number, total: number | undefined, speed: number) => void;
  /**
   * Largest piece per ranged request; default 10 MiB (keeps YouTube from throttling a single long
   * stream). Pieces are smaller for smaller files, so every connection gets work.
   */
  chunkSize?: number;
  /** Parallel ranged requests; default 16 (sites cap each connection, not the total). */
  connections?: number;
  /** Other URLs serving the same file (CDN mirrors): pieces are spread over all of them. */
  mirrors?: string[];
  /** Known content length, skips probing. */
  size?: number;
}

interface PartMeta {
  size: number;
  chunk: number;
  done: number[];
  /** Bytes already written for unfinished chunks, so a resume continues mid-chunk. */
  partial?: Record<string, number>;
}

/**
 * Download `url` to `dest`. Uses parallel Range requests when the server allows them, writes into
 * `dest.part` and remembers finished chunks in `dest.part.json`, so a paused or failed download
 * resumes where it stopped. Returns the final size.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions): Promise<number> {
  await mkdir(dirname(dest), { recursive: true });
  const headers = { 'user-agent': UA, ...opts.headers };
  const size = opts.size ?? (await probe(url, headers, opts.signal));
  const done = await stat(dest).then((s) => s.size, () => -1);
  if (size !== undefined && done === size) return size;

  const meter = new Meter(opts.onProgress, size);
  try {
    if (size === undefined || size === 0) await single(url, dest, headers, opts.signal, meter);
    else await ranged(url, dest, size, headers, opts, meter);
  } finally {
    meter.stop();
  }
  return size ?? (await stat(dest)).size;
}

/** Content length via a 1-byte Range request; undefined if the server does not do ranges. */
async function probe(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<number | undefined> {
  const res = await proxiedFetch(url, { headers: { ...headers, range: 'bytes=0-0' }, signal });
  await res.body?.cancel();
  if (res.status === 206) {
    const total = res.headers.get('content-range')?.split('/')[1];
    return total && total !== '*' ? Number(total) : undefined;
  }
  if (!res.ok) throw new HttpError(res.status, url);
  return undefined;
}

async function single(url: string, dest: string, headers: Record<string, string>, signal: AbortSignal, meter: Meter) {
  const res = await proxiedFetch(url, { headers, signal });
  if (!res.ok || !res.body) throw new HttpError(res.status, url);
  const len = Number(res.headers.get('content-length'));
  if (len) meter.total = len;
  const part = `${dest}.part`;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (b: Buffer) => meter.add(b.length));
  await pipeline(body, createWriteStream(part), { signal });
  await rename(part, dest);
}

async function ranged(
  url: string,
  dest: string,
  size: number,
  headers: Record<string, string>,
  opts: DownloadOptions,
  meter: Meter,
) {
  const connections = opts.connections ?? (settingNumber('connections') || CONNECTIONS);
  const chunk = chunkFor(size, connections, opts.chunkSize ?? MAX_CHUNK);
  const count = Math.ceil(size / chunk);
  const urls = [url, ...(opts.mirrors ?? []).filter((m) => m && m !== url)];
  const part = `${dest}.part`;
  const metaPath = `${part}.json`;
  const span = (i: number) => Math.min(chunk, size - i * chunk);

  let meta: PartMeta = { size, chunk, done: [] };
  try {
    const saved = JSON.parse(await readFile(metaPath, 'utf8')) as PartMeta;
    const partSize = await stat(part).then((s) => s.size, () => -1);
    if (saved.size === size && saved.chunk === chunk && partSize >= 0) meta = saved;
  } catch {
    // fresh start
  }
  const finished = new Set(meta.done);
  const got = new Map<number, number>();
  for (const i of finished) meter.add(span(i), true);
  for (const [k, n] of Object.entries(meta.partial ?? {})) {
    const i = Number(k);
    if (finished.has(i) || !(n > 0)) continue;
    got.set(i, Math.min(n, span(i)));
    meter.add(got.get(i)!, true);
  }

  const fh: FileHandle = await open(part, finished.size || got.size ? 'r+' : 'w');
  let saving = Promise.resolve();
  let lastSave = 0;
  const persist = (force = false) => {
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    meta.done = [...finished];
    meta.partial = Object.fromEntries([...got].filter(([i]) => !finished.has(i)));
    const snapshot = JSON.stringify(meta);
    saving = saving.then(() => writeFile(metaPath, snapshot));
  };

  const pending = Array.from({ length: count }, (_, i) => i).filter((i) => !finished.has(i));
  const worker = async () => {
    for (let i = pending.shift(); i !== undefined; i = pending.shift()) {
      await fetchChunk(urls, fh, i, i * chunk, span(i), got, headers, opts.signal, meter, persist);
      finished.add(i);
      got.delete(i);
      persist(true);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(connections, count) }, worker));
  } finally {
    persist(true);
    await saving;
    await fh.close();
  }
  await rename(part, dest);
  await rm(metaPath, { force: true });
}

const CONNECTIONS = 16;
const MAX_CHUNK = 10 * 1024 * 1024;
const MIN_CHUNK = 1024 * 1024;
/** Received bytes are written in batches of this size rather than per network packet. */
const WRITE_BATCH = 1024 * 1024;

/**
 * Piece size: about four pieces per connection, so the last pieces finish close together, but
 * never under 1 MiB (each request has a round trip) or over the site's limit.
 */
export function chunkFor(size: number, connections: number, max: number): number {
  return Math.min(max, Math.max(MIN_CHUNK, Math.ceil(size / (connections * 4))));
}

/**
 * Fetch chunk `i` into place. Bytes that reached the file stay valid, so retries and resumes
 * continue from `got[i]` instead of starting the chunk over.
 */
async function fetchChunk(
  urls: string[],
  fh: FileHandle,
  i: number,
  start: number,
  length: number,
  got: Map<number, number>,
  headers: Record<string, string>,
  signal: AbortSignal,
  meter: Meter,
  persist: () => void,
) {
  for (let attempt = 0; ; attempt++) {
    const offset = got.get(i) ?? 0;
    if (offset >= length) return;
    // Pieces rotate over the mirrors; a retry moves on to the next one.
    const url = urls[(i + attempt) % urls.length]!;
    try {
      const range = `bytes=${start + offset}-${start + length - 1}`;
      const res = await proxiedFetch(url, { headers: { ...headers, range }, signal });
      if (res.status !== 206 || !res.body) throw new HttpError(res.status, url, `分段下载失败 HTTP ${res.status}`);
      let written = offset;
      let batch: Uint8Array[] = [];
      let batched = 0;
      const flush = async () => {
        if (!batched) return;
        const data = batch.length === 1 ? batch[0]! : Buffer.concat(batch);
        await fh.write(data, 0, batched, start + written);
        written += batched;
        batch = [];
        batched = 0;
        got.set(i, written);
        persist();
      };
      try {
        for await (const buf of res.body as AsyncIterable<Uint8Array>) {
          const n = Math.min(buf.length, length - written - batched);
          if (n <= 0) break;
          batch.push(n === buf.length ? buf : buf.subarray(0, n));
          batched += n;
          meter.add(n);
          if (batched >= WRITE_BATCH) await flush();
        }
      } finally {
        // Keep what arrived, even when the connection broke: a retry continues after it.
        await flush();
      }
      if (written < length) throw new Error(`分段不完整 ${written}/${length}`);
      return;
    } catch (err) {
      if (signal.aborted || attempt >= 3 || (err instanceof HttpError && err.status === 403 && attempt >= 1)) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

/** Tracks bytes and reports progress with a smoothed speed, at most every 250ms. */
class Meter {
  private bytes = 0;
  private speed = 0;
  private lastBytes = 0;
  private lastAt = Date.now();
  private timer: NodeJS.Timeout;

  constructor(
    private readonly cb: DownloadOptions['onProgress'],
    public total: number | undefined,
  ) {
    this.timer = setInterval(() => this.tick(), 250);
  }

  /** `resumed` bytes count toward progress but not speed. */
  add(n: number, resumed = false): void {
    this.bytes += n;
    if (resumed) this.lastBytes += n;
  }

  private tick(): void {
    const now = Date.now();
    const inst = ((this.bytes - this.lastBytes) * 1000) / Math.max(1, now - this.lastAt);
    this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
    this.lastBytes = this.bytes;
    this.lastAt = now;
    this.cb?.(this.bytes, this.total, Math.max(0, this.speed));
  }

  stop(): void {
    clearInterval(this.timer);
    this.tick();
  }
}
