import { parentPort } from 'node:worker_threads';
import { bookInfo, content, search, toc } from './flow.ts';
import type { Job, Reply } from './remote.ts';

/**
 * Book-source work in a worker thread. Legado scripts are synchronous — `java.ajax` waits for its
 * response — so they run here, where waiting blocks only this thread, never the interface.
 */
export function startNovelWorker(): void {
  const port = parentPort;
  if (!port) return;
  const running = new Map<number, AbortController>();
  port.on('message', async (m: Job | { cancel: number }) => {
    if ('cancel' in m) {
      running.get(m.cancel)?.abort();
      return;
    }
    const ctl = new AbortController();
    running.set(m.id, ctl);
    let reply: Reply;
    try {
      if (m.op === 'search') {
        reply = { id: m.id, ok: true, value: await search(m.source, m.key, ctl.signal, m.page) };
      } else {
        const book = m.book;
        let value: unknown;
        if (m.op === 'bookInfo') await bookInfo(book, ctl.signal);
        else if (m.op === 'toc') value = await toc(book, ctl.signal);
        else if (m.op === 'content') value = await content(book, m.chapter, m.next, ctl.signal);
        // Scripts update the book (variables, the fetched page, tocUrl …): send it back too.
        reply = { id: m.id, ok: true, value, book };
      }
    } catch (err) {
      reply = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined };
    } finally {
      running.delete(m.id);
    }
    port.postMessage(reply);
  });
}
