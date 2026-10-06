import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followRedirects, pageRedirect } from '../src/links.ts';
import { Session } from '../src/session.ts';
import { TaskQueue } from '../src/queue.ts';
import { install } from '../src/registry.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const to = (location: string) => (res.writeHead(302, { location }), res.end());
    const html = (body: string) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end(body));
    if (req.url === '/a') return to('/b');
    if (req.url === '/b') return to(`${base}/meta`);
    if (req.url === '/meta') return html('<meta http-equiv="refresh" content="0;url=/js">');
    if (req.url === '/js') return html('<script>window.location.href = "/end?x=1&amp;y=2"</script>');
    if (req.url?.startsWith('/end')) return html('<p>done</p>');
    if (req.url === '/away') return to('http://song.fake-music.invalid/track/42');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe('link resolution', () => {
  it('follows HTTP, meta-refresh and script redirects to the end', async () => {
    expect(await followRedirects(`${base}/a`)).toBe(`${base}/end?x=1&y=2`);
  });

  it('keeps the last place reached when the target refuses plain requests', async () => {
    expect(await followRedirects(`${base}/away`)).toBe('http://song.fake-music.invalid/track/42');
  });

  it('reads page redirects', () => {
    expect(pageRedirect('<META HTTP-EQUIV="Refresh" CONTENT="0; URL=https://x.test/a&amp;b">')).toBe('https://x.test/a&b');
    expect(pageRedirect('<script>location.replace("https:\/\/y.test\/p")</script>')).toBe('https://y.test/p');
    expect(pageRedirect('<p>nothing</p>')).toBeUndefined();
  });

  it('a link no module knows is followed and routed by where it lands', async () => {
    let opened = '';
    install({
      id: 'fake-music',
      setup(api) {
        api.host({ pattern: /(^|\.)fake-music\.invalid$/, kind: 'music', site: 'fake' });
        api.handler({ id: 'fake', kinds: ['music'], match: (i) => i.site === 'fake', handle: async (ctx) => void (opened = ctx.intent.input) });
      },
    });
    const s = new Session(new TaskQueue());
    await s.input(`${base}/away`);
    expect(opened).toBe('http://song.fake-music.invalid/track/42');
  });
});
