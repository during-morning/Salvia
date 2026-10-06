import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Book, Chapter } from './flow.ts';
import * as inline from './flow.ts';
import type { BookSource } from './source.ts';

/**
 * The book-source operations, run in a few worker threads (see worker.ts). Same signatures as
 * flow.ts; the book a script changed comes back into the caller's object. Without workers
 * (they failed to start, or SALVIA_NOVEL_INLINE=1) everything runs on this thread as before.
 */

export type Job =
  | { id: number; op: 'search'; source: BookSource; key: string; page?: number }
  | { id: number; op: 'bookInfo' | 'toc'; book: Book }
  | { id: number; op: 'content'; book: Book; chapter: Chapter; next?: string };

export type Reply = { id: number; ok: true; value?: unknown; book?: Book } | { id: number; ok: false; error: string; name?: string };

type JobInput = Job extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never;

interface Slot {
  worker: Worker;
  pending: Map<number, { resolve: (r: Reply) => void; reject: (e: unknown) => void }>;
}

const SIZE = Math.max(2, Math.min(4, availableParallelism() - 1));
let slots: Slot[] | null | undefined;
let seq = 0;

/** The worker script: worker-entry.ts from source, or this same bundle in the packaged build. */
function workerTarget(): { url: URL; workerData?: unknown } {
  const here = import.meta.url;
  if (/\.ts$/.test(here)) return { url: new URL('./worker-entry.ts', here) };
  return { url: new URL(here), workerData: { salvia: 'novel-worker' } };
}

function start(): Slot[] | null {
  if (process.env.SALVIA_NOVEL_INLINE === '1') return null;
  try {
    const { url, workerData } = workerTarget();
    return Array.from({ length: SIZE }, () => {
      const worker = new Worker(url, { workerData, stdout: true, stderr: true });
      // A worker must never keep the app alive, nor write into the TUI.
      worker.unref();
      const slot: Slot = { worker, pending: new Map() };
      worker.on('message', (r: Reply) => {
        slot.pending.get(r.id)?.resolve(r);
        slot.pending.delete(r.id);
      });
      worker.on('error', (err) => {
        for (const p of slot.pending.values()) p.reject(err);
        slot.pending.clear();
      });
      return slot;
    });
  } catch {
    return null;
  }
}

function pool(): Slot[] | null {
  if (slots === undefined) slots = start();
  return slots;
}

async function call(job: JobInput, signal?: AbortSignal): Promise<Reply> {
  const all = pool()!;
  // The least busy worker; while one waits on a slow site the others go on.
  const slot = all.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  const id = ++seq;
  signal?.throwIfAborted();
  return new Promise<Reply>((resolve, reject) => {
    const onAbort = () => {
      slot.worker.postMessage({ cancel: id });
      slot.pending.delete(id);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    slot.pending.set(id, {
      resolve: (r) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      },
      reject: (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    });
    slot.worker.postMessage({ ...job, id });
  });
}

function unwrap(r: Reply): Extract<Reply, { ok: true }> {
  if (r.ok) return r;
  const err = new Error(r.error);
  if (r.name) err.name = r.name;
  throw err;
}

export async function search(source: BookSource, key: string, signal?: AbortSignal, page = 1): Promise<Book[]> {
  if (!pool()) return inline.search(source, key, signal, page);
  return unwrap(await call({ op: 'search', source, key, page }, signal)).value as Book[];
}

export async function bookInfo(book: Book, signal?: AbortSignal): Promise<Book> {
  if (!pool()) return inline.bookInfo(book, signal);
  return Object.assign(book, unwrap(await call({ op: 'bookInfo', book }, signal)).book);
}

export async function toc(book: Book, signal?: AbortSignal): Promise<Chapter[]> {
  if (!pool()) return inline.toc(book, signal);
  const r = unwrap(await call({ op: 'toc', book }, signal));
  Object.assign(book, r.book);
  return r.value as Chapter[];
}

export async function content(book: Book, chapter: Chapter, nextChapterUrl?: string, signal?: AbortSignal): Promise<string> {
  if (!pool()) return inline.content(book, chapter, nextChapterUrl, signal);
  const r = unwrap(await call({ op: 'content', book, chapter, next: nextChapterUrl }, signal));
  Object.assign(book, r.book);
  return r.value as string;
}
