import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { explainError, type Session, type View, type ViewPart } from '@salvia/core';
import { clipStream } from '@salvia/media';
import { RateLimiter, ServerStats, serverInputFilter } from './guard.ts';
import { attachment, zipFolder } from './send.ts';
import { loadAssets, serveAsset } from './static.ts';

export { RateLimiter, ServerStats, serverInputFilter, type LogLine } from './guard.ts';

/** packages/web/dist in a source checkout, or web/ next to the bundled app.mjs. */
function webDist(): string | undefined {
  for (const rel of ['../../web/dist', './web']) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(dir)) return dir;
    } catch {
      // not a file URL
    }
  }
  return undefined;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  webDir?: string;
  /**
   * Server mode (`@web:server`): every browser gets its own session from this factory, requests
   * are rate limited per address, and logins / settings can't be changed from the network.
   */
  serve?: { createSession: () => Session; stats?: ServerStats; maxSessions?: number };
}

const COOKIE = 'salvia_sid';
/** Server mode: event streams one address may hold open (browser tabs). */
const STREAMS_PER_IP = 8;
/** JSON responses bigger than this are compressed (long result lists, completions). */
const COMPRESS_OVER = 4096;

function compressJson(req: FastifyRequest, reply: FastifyReply, payload: unknown): unknown {
  if (typeof payload !== 'string' || payload.length < COMPRESS_OVER) return payload;
  if (!String(reply.getHeader('content-type') ?? '').includes('json')) return payload;
  const accept = String(req.headers['accept-encoding'] ?? '');
  reply.header('vary', 'accept-encoding');
  if (/\bbr\b/.test(accept)) {
    reply.header('content-encoding', 'br');
    return brotliCompressSync(payload, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  }
  if (/\bgzip\b/.test(accept)) {
    reply.header('content-encoding', 'gzip');
    return gzipSync(payload, { level: 6 });
  }
  return payload;
}
const IDLE_MS = 30 * 60_000;
/** Requests that make Salvia call the music / video / novel sites. */
const HEAVY = /^\/api\/(input|pick|preview|back)\b/;

export async function startServer(session: Session, opts: ServerOptions = {}) {
  const app = Fastify({ trustProxy: false });
  const serve = opts.serve;
  const stats = serve ? (serve.stats ?? new ServerStats()) : undefined;
  const limiter = new RateLimiter();
  const streamsByIp = new Map<string, number>();
  /** Files on their way to a browser (server mode sends each once). */
  const sending = new Set<string>();
  app.addHook('onSend', async (req, reply, payload) => compressJson(req, reply, payload));

  /** This request's session: the shared one, or in server mode the browser's own. */
  const sessionOf = (req: FastifyRequest, reply: FastifyReply): Session | undefined => {
    if (!serve || !stats) return session;
    const sid = /(?:^|;\s*)salvia_sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const known = sid ? stats.sessions.get(sid) : undefined;
    if (known) {
      known.last = Date.now();
      return known.session;
    }
    if (stats.sessions.size >= (serve.maxSessions ?? 100)) return undefined;
    const id = randomUUID();
    const s = serve.createSession();
    s.setInputFilter(serverInputFilter);
    stats.sessions.set(id, { session: s, ip: req.ip, last: Date.now(), streams: 0 });
    s.queue.on('change', (t) => {
      if (t.status === 'done') stats.push(req.ip, `下载完成：${t.title}`, 'ok');
      else if (t.status === 'error') stats.push(req.ip, `下载失败：${t.title}（${t.error ?? ''}）`, 'error');
      stats.changed();
    });
    reply.header('set-cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    stats.push(req.ip, '新客户端');
    return s;
  };

  if (serve && stats) {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      stats.requests++;
      const wait = limiter.take(req.ip, HEAVY.test(req.url));
      if (wait !== undefined) {
        stats.limited++;
        if (stats.limited % 10 === 1) stats.push(req.ip, `请求太频繁，已限流（${wait} 秒）`, 'error');
        stats.changed();
        return reply.code(429).header('retry-after', String(wait)).send({ error: `请求太频繁，请 ${wait} 秒后再试。` });
      }
      stats.changed();
    });
    // Idle browsers' sessions are dropped (their running downloads keep them alive).
    const sweep = setInterval(() => {
      limiter.sweep();
      const now = Date.now();
      for (const [id, s] of stats.sessions) {
        const busy = s.session.queue.list().some((t) => t.status === 'running' || t.status === 'queued');
        if (!busy && !s.streams && now - s.last > IDLE_MS) {
          s.session.dispose();
          stats.sessions.delete(id);
        }
      }
      stats.changed();
    }, 60_000);
    app.addHook('onClose', async () => {
      clearInterval(sweep);
      for (const s of stats.sessions.values()) s.session.dispose();
      stats.sessions.clear();
    });
  }

  const withSession =
    <T>(fn: (s: Session, req: FastifyRequest, reply: FastifyReply) => T) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const s = sessionOf(req, reply);
      if (!s) return reply.code(503).send({ error: '服务端连接数已满，请稍后再试。' });
      return fn(s, req, reply);
    };

  const viewOf = (s: Session): View & { server?: boolean } => ({ ...s.view(), server: !!serve });

  app.get('/api/view', withSession((s) => viewOf(s)));
  app.get('/api/commands', withSession((s) => s.commandList()));
  app.get(
    '/api/complete',
    withSession((s, req) => s.complete(String((req.query as { text?: string }).text ?? ''))),
  );

  app.get(
    '/api/mark',
    withSession((s, req) => ({ length: s.commandMark(String((req.query as { text?: string }).text ?? '')) })),
  );

  app.post(
    '/api/input',
    withSession((s, req) => {
      const text = String((req.body as { text?: string } | undefined)?.text ?? '');
      if (stats && text.trim()) stats.push(req.ip, text.trim().slice(0, 80));
      void s.input(text);
      return { ok: true };
    }),
  );

  app.post(
    '/api/pick',
    withSession((s, req) => {
      void s.pick(String((req.body as { id?: string } | undefined)?.id ?? ''));
      return { ok: true };
    }),
  );

  app.post(
    '/api/pick-many',
    withSession((s, req) => {
      const ids = (req.body as { ids?: unknown } | undefined)?.ids;
      void s.pickMany(Array.isArray(ids) ? ids.map(String) : []);
      return { ok: true };
    }),
  );

  // Opening a result: its preview, and (with `pick`) its download options in the list at once.
  // The preview reads the row before the pick replaces the list, so both start here, in order.
  app.post(
    '/api/preview',
    withSession(async (s, req, reply) => {
      const body = req.body as { id?: string; pick?: boolean } | undefined;
      const id = String(body?.id ?? '');
      const preview = s.preview(id);
      if (body?.pick) void s.pick(id);
      try {
        return await preview;
      } catch (err) {
        return reply.code(400).send({ error: explainError(err) });
      }
    }),
  );

  app.post('/api/back', withSession((s) => ({ ok: s.back() })));

  // The last preview's clip as MP3, for <audio>.
  app.get(
    '/api/preview/audio',
    withSession((s, req, reply) => {
      const clip = s.previewClip();
      if (!clip) return reply.code(404).send();
      const controller = new AbortController();
      req.raw.on('close', () => controller.abort());
      return reply.type('audio/mpeg').header('cache-control', 'no-store').send(clipStream(clip, controller.signal));
    }),
  );

  app.post(
    '/api/task/:id/:action',
    withSession(async (s, req, reply) => {
      const { id, action } = req.params as { id: string; action: string };
      if (action === 'pause') s.pause(id);
      else if (action === 'cancel') s.cancel(id);
      else if (action === 'remove') await s.remove(id);
      // Deleting files on a shared server is the operator's business.
      else if (action === 'delete' && !serve) await s.remove(id, true);
      else return reply.code(404).send({ ok: false });
      return { ok: true };
    }),
  );

  // A finished download, to save in the browser (the file itself is on the machine running Salvia).
  app.get(
    '/api/task/:id/file',
    withSession(async (s, req, reply) => {
      const id = (req.params as { id: string }).id;
      const task = s.queue.get(id);
      const path = task?.status === 'done' ? task.outputPath : undefined;
      if (!task || !path || !existsSync(path)) return reply.code(404).send({ error: '文件不存在（可能已经发送过了）。' });
      // Server mode: one browser takes the file; the server keeps no copy once it arrived.
      if (serve) {
        if (sending.has(id)) return reply.code(409).send({ error: '正在发送给另一个页面。' });
        sending.add(id);
      }
      const folder = statSync(path).isDirectory();
      const body = folder ? await zipFolder(path) : createReadStream(path);
      reply.header('content-disposition', attachment(folder ? `${basename(path)}.zip` : basename(path))).type(folder ? 'application/zip' : 'application/octet-stream');
      if (!folder) reply.header('content-length', String(statSync(path).size));
      if (serve) {
        reply.raw.on('close', () => {
          sending.delete(id);
          // Delivered in full: drop the file and the task here. Broken off: keep both for a retry.
          if (!reply.raw.writableFinished) return;
          stats?.push(req.ip, `已发送并移除：${task.title}`, 'ok');
          void s.remove(id, true).then(() => s.forgetDownload(id));
        });
      }
      return reply.send(body);
    }),
  );

  // The view once, then only the parts that change (`patch`), merged while the socket is busy.
  app.get(
    '/api/events',
    withSession((s, req, reply) => {
      if (serve) {
        const open = streamsByIp.get(req.ip) ?? 0;
        if (open >= STREAMS_PER_IP) return reply.code(429).send({ error: '这个地址打开的页面太多了，请关闭一些再试。' });
        streamsByIp.set(req.ip, open + 1);
      }
      reply.hijack();
      const res = reply.raw;
      // A cookie set for a new browser still has to reach it.
      const cookie = reply.getHeader('set-cookie');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...(cookie ? { 'set-cookie': cookie as string } : {}),
      });
      let blocked = !res.write(`event: view\ndata: ${JSON.stringify(viewOf(s))}\n\n`);
      let pending = new Set<ViewPart>();
      const flush = () => {
        if (!pending.size) return;
        const data = s.partsJson(pending);
        pending = new Set();
        blocked = !res.write(`event: patch\ndata: ${data}\n\n`);
      };
      const onPatch = (parts: Set<ViewPart>) => {
        for (const p of parts) pending.add(p);
        if (!blocked) flush();
      };
      const onDrain = () => {
        blocked = false;
        flush();
      };
      res.on('drain', onDrain);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      s.on('patch', onPatch);
      const entry = stats && [...stats.sessions.values()].find((e) => e.session === s);
      if (stats) {
        stats.streams++;
        if (entry) entry.streams++;
        stats.changed();
      }
      req.raw.on('close', () => {
        clearInterval(ping);
        s.off('patch', onPatch);
        res.off('drain', onDrain);
        if (serve) {
          const n = (streamsByIp.get(req.ip) ?? 1) - 1;
          if (n > 0) streamsByIp.set(req.ip, n);
          else streamsByIp.delete(req.ip);
        }
        if (stats) {
          stats.streams--;
          if (entry) {
            entry.streams--;
            entry.last = Date.now();
          }
          stats.changed();
        }
      });
    }),
  );

  const assets = loadAssets(opts.webDir ?? webDist());
  app.get('/*', (req, reply) => serveAsset(assets, req, reply));

  const address = await app.listen({ port: opts.port ?? 8080, host: opts.host ?? '127.0.0.1' });
  return { app, address, stats };
}
