import { request } from './http.ts';

/**
 * Where a link ends up: short links and share links (t.cn, apple.co, c.migu.cn, b23.tv …) are
 * followed through HTTP redirects and the HTML / script redirects some shorteners use instead.
 * Used when a link's platform can't be told from its text, and by platforms for their own share
 * links.
 */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** A redirect written into a page: <meta http-equiv="refresh">, location.href = … / location.replace(…). */
export function pageRedirect(html: string): string | undefined {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i)?.[1];
  if (meta) return meta.replace(/&amp;/g, '&');
  const js = html.match(/(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/) ?? html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/);
  return js?.[1]?.replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

export async function followRedirects(url: string, opts: { signal?: AbortSignal; hops?: number; userAgent?: string; headers?: Record<string, string> } = {}): Promise<string> {
  let current = url;
  for (let hop = 0; hop < (opts.hops ?? 6); hop++) {
    let res: Response;
    try {
      res = await request(current, {
        redirect: 'manual',
        signal: opts.signal,
        retries: 1,
        timeout: 10_000,
        headers: { 'user-agent': opts.userAgent ?? MOBILE_UA, ...opts.headers },
      });
    } catch (err) {
      // The target itself may refuse plain requests (or need a login); where it is is known.
      if (hop === 0 || opts.signal?.aborted) throw err;
      return current;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      await res.body?.cancel();
      current = new URL(location, current).href;
      continue;
    }
    // A small HTML page may redirect by itself (some shorteners and share pages do).
    const type = res.headers.get('content-type') ?? '';
    const size = Number(res.headers.get('content-length') ?? 0);
    if (!/html/i.test(type) || size > 256 * 1024) {
      await res.body?.cancel();
      return current;
    }
    const next = pageRedirect((await res.text()).slice(0, 256 * 1024));
    if (!next) return current;
    const target = new URL(next, current).href;
    if (target === current) return current;
    current = target;
  }
  return current;
}
