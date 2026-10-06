import { getText, getJson } from '@salvia/core';
import { WEB, type ClientConfig } from './config.ts';

/**
 * The visitor id a browser session carries (ytcfg VISITOR_DATA on youtube.com), sent with every
 * InnerTube call as yt-dlp does. Without one, YouTube answers some videos with "Sign in to confirm
 * you're not a bot". Fetched once and kept for a few hours.
 */
let visitor: { id: string; at: number } | undefined;
const VISITOR_TTL = 6 * 3600 * 1000;

export async function visitorData(signal?: AbortSignal, fresh = false): Promise<string | undefined> {
  if (!fresh && visitor && Date.now() - visitor.at < VISITOR_TTL) return visitor.id;
  try {
    const html = await getText('https://www.youtube.com/', {
      headers: { 'user-agent': WEB.userAgent, 'accept-language': 'en' },
      signal,
      retries: 1,
    });
    const id = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
    if (id) visitor = { id, at: Date.now() };
    return id ?? visitor?.id;
  } catch {
    return visitor?.id; // carry on without; most videos work anyway
  }
}

/** POST an InnerTube endpoint (player, next, browse, search) as the given client. */
export async function innertube<T = unknown>(
  endpoint: string,
  client: ClientConfig,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  opts: { freshVisitor?: boolean } = {},
): Promise<T> {
  const host = client.host ?? 'www.youtube.com';
  const vd = await visitorData(signal, opts.freshVisitor);
  return getJson<T>(`https://${host}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'user-agent': client.userAgent,
      'x-youtube-client-name': String(client.id),
      'x-youtube-client-version': client.version,
      origin: `https://${host}`,
      ...(vd ? { 'x-goog-visitor-id': vd } : {}),
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: client.name,
          clientVersion: client.version,
          userAgent: client.userAgent,
          hl: 'en',
          gl: 'US',
          ...(vd ? { visitorData: vd } : {}),
          ...client.extra,
        },
      },
      ...body,
    }),
  });
}

/** Text from InnerTube's `{simpleText}` / `{runs:[{text}]}` shapes. */
export function text(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { simpleText?: string; runs?: { text: string }[]; content?: string };
  return n.simpleText ?? n.content ?? n.runs?.map((r) => r.text).join('') ?? '';
}

/** "3:32" / "1:02:03" → seconds */
export function parseClock(s: string): number | undefined {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(s)) return undefined;
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Depth-first collect every value under `key` anywhere in a JSON tree, including nested ones. */
export function collect<T>(root: unknown, key: string, out: T[] = []): T[] {
  if (Array.isArray(root)) for (const v of root) collect(v, key, out);
  else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key) out.push(v as T);
      collect(v, key, out);
    }
  }
  return out;
}
