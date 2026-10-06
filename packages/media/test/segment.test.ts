import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkFor, downloadFile } from '../src/segment.ts';

const DATA = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
let server: Server;
let base = '';
let served = 0;
let failNext = 0;
let slow = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (req.url === '/norange' || !range) {
      res.writeHead(200, { 'content-length': DATA.length });
      return res.end(DATA);
    }
    if (failNext > 0) {
      failNext--;
      res.writeHead(500);
      return res.end();
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), DATA.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${DATA.length}`, 'content-length': end - start + 1 });
    const body = DATA.subarray(start, end + 1);
    served += body.length;
    if (!slow) return res.end(body);
    // Send half, then the rest later, so an abort lands mid-chunk.
    const half = Math.floor(body.length / 2);
    res.write(body.subarray(0, half));
    setTimeout(() => res.end(body.subarray(half)), 150);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => server.close());

const dir = () => mkdtempSync(join(tmpdir(), 'salvia-seg-'));

describe('downloadFile', () => {
  it('downloads with parallel ranges', async () => {
    const out = join(dir(), 'a.bin');
    let last = 0;
    const size = await downloadFile(`${base}/file`, out, {
      signal: new AbortController().signal,
      chunkSize: 64 * 1024,
      onProgress: (d) => (last = d),
    });
    expect(size).toBe(DATA.length);
    expect(readFileSync(out).equals(DATA)).toBe(true);
    expect(last).toBe(DATA.length);
    expect(existsSync(`${out}.part.json`)).toBe(false);
  });

  it('falls back to a single stream without range support', async () => {
    const out = join(dir(), 'b.bin');
    await downloadFile(`${base}/norange`, out, { signal: new AbortController().signal });
    expect(readFileSync(out).equals(DATA)).toBe(true);
  });

  it('retries failed chunks', async () => {
    const out = join(dir(), 'c.bin');
    failNext = 2;
    await downloadFile(`${base}/file`, out, { signal: new AbortController().signal, chunkSize: 100_000, size: DATA.length });
    expect(readFileSync(out).equals(DATA)).toBe(true);
  });

  it('resumes after abort, continuing mid-chunk', async () => {
    const out = join(dir(), 'd.bin');
    const ac = new AbortController();
    slow = true;
    const first = downloadFile(`${base}/file`, out, { signal: ac.signal, chunkSize: 100_000, connections: 2, size: DATA.length });
    await new Promise((r) => setTimeout(r, 220));
    ac.abort();
    await expect(first).rejects.toBeTruthy();
    slow = false;
    const saved = JSON.parse(readFileSync(`${out}.part.json`, 'utf8')) as { done: number[]; partial: Record<string, number> };
    const have = saved.done.length * 100_000 + Object.values(saved.partial).reduce((a, b) => a + b, 0);
    expect(Object.keys(saved.partial).length).toBeGreaterThan(0);
    served = 0;
    await downloadFile(`${base}/file`, out, { signal: new AbortController().signal, chunkSize: 100_000, size: DATA.length });
    expect(served).toBe(DATA.length - have);
    expect(readFileSync(out).equals(DATA)).toBe(true);
  });
});

describe('chunkFor', () => {
  it('about four pieces per connection, at least 1 MiB, at most the limit', () => {
    const MB = 1024 * 1024;
    expect(chunkFor(27 * MB, 16, 10 * MB)).toBe(MB); // small files still spread over connections
    expect(chunkFor(640 * MB, 16, 10 * MB)).toBe(10 * MB);
    expect(chunkFor(200 * MB, 16, 9 * MB)).toBe(Math.ceil((200 * MB) / 64));
    expect(chunkFor(300_000, 2, 100_000)).toBe(100_000); // the caller's limit wins
  });
});
