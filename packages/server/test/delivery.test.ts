import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, TaskQueue, resetConfigCache } from '@salvia/core';
import { startServer } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'salvia-deliver-'));
let session: Session;
let app: Awaited<ReturnType<typeof startServer>>['app'];
let base = '';
let cookie = '';

const done = (path: string) =>
  new Promise<string>((resolve) => {
    const t = session.queue.add({ kind: 'x', title: path, run: async () => path });
    const check = () => (session.queue.get(t.id)?.status === 'done' ? resolve(t.id) : setTimeout(check, 10));
    check();
  });

beforeAll(async () => {
  process.env.SALVIA_HOME = mkdtempSync(join(tmpdir(), 'salvia-deliver-home-'));
  resetConfigCache();
  // Server mode with one known session: the first browser gets it.
  const started = await startServer(new Session(new TaskQueue()), {
    port: 0,
    serve: { createSession: () => (session = new Session(new TaskQueue())) },
  });
  app = started.app;
  base = started.address;
  const res = await fetch(`${base}/api/view`);
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(() => app.close());

describe('server mode delivery', () => {
  it('sends a finished file once, then drops it and its task', async () => {
    const file = join(dir, '晴天.mp3');
    writeFileSync(file, 'audio');
    const id = await done(file);
    const res = await fetch(`${base}/api/task/${id}/file`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''%E6%99%B4%E5%A4%A9.mp3");
    expect(await res.text()).toBe('audio');
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(file)).toBe(false);
    expect(session.queue.get(id)).toBeUndefined();
    expect((await fetch(`${base}/api/task/${id}/file`, { headers: { cookie } })).status).toBe(404);
  });

  it('sends a folder as a zip', async () => {
    const folder = join(dir, '番剧');
    mkdirSync(join(folder, 'S01'), { recursive: true });
    writeFileSync(join(folder, 'S01', '01.mkv'), 'one');
    writeFileSync(join(folder, 'notes.txt'), 'two');
    const id = await done(folder);
    const res = await fetch(`${base}/api/task/${id}/file`, { headers: { cookie } });
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['番剧/S01/01.mkv', '番剧/notes.txt']);
    expect(new TextDecoder().decode(files['番剧/S01/01.mkv'])).toBe('one');
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(folder)).toBe(false);
  });
});
