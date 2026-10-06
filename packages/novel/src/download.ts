import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cacheDir, request, type Progress } from '@salvia/core';
import { buildEpub, buildTxt, type EpubChapter } from './export/epub.ts';
import type { Book, Chapter } from './flow.ts';
import { content, toc } from './remote.ts';

export type BookFormat = 'epub' | 'txt';

/** Chapters fetched at once; failures get a second, gentler pass (sites that rate-limit). */
const CONCURRENCY = 12;
const RETRY_CONCURRENCY = 2;
const FAILED_TEXT = '（本章获取失败，可稍后重新下载补全）';

function cacheFor(book: Book): string {
  const key = createHash('sha1').update(`${book.source.bookSourceUrl}\n${book.bookUrl}`).digest('hex').slice(0, 16);
  return cacheDir('novel', key);
}

async function fetchChapter(book: Book, ch: Chapter, next: Chapter | undefined, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await content(book, ch, next?.url, signal);
    } catch (err) {
      if (signal.aborted || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}

async function cover(url: string | undefined, signal: AbortSignal): Promise<{ data: Uint8Array; mime: string } | undefined> {
  if (!url) return undefined;
  try {
    const res = await request(url, { signal, retries: 1, timeout: 15_000 });
    const mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return undefined;
    return { data: new Uint8Array(await res.arrayBuffer()), mime: mime === 'image/png' ? 'image/png' : 'image/jpeg' };
  } catch {
    return undefined;
  }
}

/**
 * Download every chapter (cached per chapter, so a paused or failed run resumes) and write the book.
 * Fails if too many chapters could not be fetched; the cache keeps what succeeded.
 */
export async function downloadBook(
  book: Book,
  format: BookFormat,
  out: string,
  signal: AbortSignal,
  report: (p: Progress) => void,
): Promise<string> {
  report({ progress: -1 });
  const chapters = await toc(book, signal);
  if (!chapters.length) throw new Error('目录是空的。');
  const dir = cacheFor(book);
  const texts: (string | undefined)[] = new Array(chapters.length);
  let done = 0;
  let failed = 0;
  let bytes = 0;
  const started = Date.now();
  const tick = () => report({ progress: (done / chapters.length) * 0.97, speed: bytes / Math.max(1, (Date.now() - started) / 1000) });

  /** Fetch (or read from cache) chapter `i`; false when it failed. */
  const one = async (i: number): Promise<boolean> => {
    const ch = chapters[i]!;
    const file = join(dir, `${i}.txt`);
    const cached = await readFile(file, 'utf8').catch(() => undefined);
    if (cached !== undefined && cached.startsWith(`${ch.url}\n`)) {
      texts[i] = cached.slice(ch.url.length + 1);
      return true;
    }
    try {
      const text = await fetchChapter(book, ch, chapters[i + 1], signal);
      texts[i] = text;
      bytes += Buffer.byteLength(text);
      await writeFile(file, `${ch.url}\n${text}`);
      return true;
    } catch (err) {
      if (signal.aborted) throw err;
      return false;
    }
  };
  const run = async (indices: number[], workers: number, last: boolean): Promise<number[]> => {
    const missed: number[] = [];
    let next = 0;
    const worker = async () => {
      while (next < indices.length) {
        const i = indices[next++]!;
        if (await one(i)) done++;
        else if (last) {
          texts[i] = FAILED_TEXT;
          failed++;
          done++;
        } else missed.push(i);
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, indices.length) }, worker));
    return missed;
  };
  const missed = await run(chapters.map((_, i) => i), CONCURRENCY, false);
  if (missed.length) await run(missed.sort((x, y) => x - y), RETRY_CONCURRENCY, true);

  if (failed > Math.max(3, chapters.length * 0.1)) {
    throw new Error(`${failed} 章获取失败（共 ${chapters.length} 章）。已成功的章节已缓存，重试会接着下载。`);
  }

  const list: EpubChapter[] = chapters.map((c, i) => ({ title: c.title, text: texts[i] ?? '', isVolume: c.isVolume }));
  await mkdir(dirname(out), { recursive: true });
  if (format === 'txt') {
    await writeFile(out, buildTxt({ title: book.name, author: book.author, intro: book.intro, chapters: list }));
  } else {
    const img = await cover(book.coverUrl, signal);
    await writeFile(out, buildEpub({ title: book.name, author: book.author, intro: book.intro, cover: img, chapters: list, source: book.bookUrl }));
  }
  report({ progress: 1 });
  return out;
}
