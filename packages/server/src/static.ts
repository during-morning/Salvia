import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { packagedAsset, packagedKeys } from '@salvia/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The web UI's files, held in memory with their compressed forms made once at start-up (brotli
 * and gzip) and an ETag. Hashed build assets (/assets/…) are cached by browsers for good;
 * index.html is revalidated. The same table serves the single-file build and a source checkout.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);

interface Asset {
  type: string;
  etag: string;
  raw: Buffer;
  br?: Buffer;
  gzip?: Buffer;
  immutable: boolean;
}

function asset(path: string, raw: Buffer): Asset {
  const ext = extname(path);
  const compress = COMPRESSIBLE.has(ext) && raw.length > 1024;
  return {
    type: MIME[ext] ?? 'application/octet-stream',
    etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`,
    raw,
    br: compress ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }) : undefined,
    gzip: compress ? gzipSync(raw, { level: 9 }) : undefined,
    immutable: path.startsWith('assets/'),
  };
}

function walk(dir: string, root = dir, out: [string, Buffer][] = []): [string, Buffer][] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push([relative(root, full).replace(/\\/g, '/'), readFileSync(full)]);
  }
  return out;
}

/** Files from the single-file build's embedded assets, or from a built web/dist folder. */
export function loadAssets(webDir?: string): Map<string, Asset> {
  const files: [string, Buffer][] = [];
  const embedded = packagedKeys('web/');
  if (embedded.length) {
    for (const key of embedded) {
      const data = packagedAsset(key);
      if (data) files.push([key.slice('web/'.length), data]);
    }
  } else if (webDir && existsSync(webDir)) {
    files.push(...walk(webDir));
  }
  return new Map(files.map(([path, data]) => [path, asset(path, data)]));
}

/** Serve a path from the table; unknown paths get the app shell (single-page app). */
export function serveAsset(assets: Map<string, Asset>, req: FastifyRequest, reply: FastifyReply) {
  const path = decodeURIComponent(req.url.split('?')[0]!).replace(/^\/+/, '') || 'index.html';
  const a = assets.get(path) ?? assets.get('index.html');
  if (!a) return reply.code(404).send();
  reply
    .header('etag', a.etag)
    .header('vary', 'accept-encoding')
    .header('cache-control', a.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    .type(a.type);
  if (req.headers['if-none-match'] === a.etag) return reply.code(304).send();
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (a.br && /\bbr\b/.test(accept)) return reply.header('content-encoding', 'br').send(a.br);
  if (a.gzip && /\bgzip\b/.test(accept)) return reply.header('content-encoding', 'gzip').send(a.gzip);
  return reply.send(a.raw);
}
