import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { loadConfig } from './config.ts';
import { registry } from './registry.ts';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message = `HTTP ${status}`,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A tiny cookie jar: name → value, per site. Good enough for API sessions; ignores paths and expiry. */
export class CookieJar {
  private map = new Map<string, string>();

  constructor(initial?: string) {
    if (initial) this.parse(initial);
  }

  /** Accepts a `Cookie:` header style string "a=1; b=2". */
  parse(header: string): void {
    for (const part of header.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }

  /** Absorb `Set-Cookie` headers from a response. */
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const first = line.split(';', 1)[0] ?? '';
      const i = first.indexOf('=');
      if (i > 0) this.map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
  }

  get(name: string): string | undefined {
    return this.map.get(name);
  }

  set(name: string, value: string): void {
    this.map.set(name, value);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Site keys `@proxy` accepts (one per module network, see registry `site`). */
export function proxySites(): string[] {
  return [...registry.sites.keys()];
}

/** Which module's network a URL belongs to. */
export function siteOf(url: string): string | undefined {
  const host = new URL(url).hostname;
  for (const s of registry.sites.values()) if (s.hosts.test(host)) return s.id;
  return undefined;
}

const agents = new Map<string, Dispatcher>();

/** The proxy configured with `@proxy <site|*> <url>` for this URL, if any. */
export function proxyFor(url: string): string | undefined {
  const proxies = loadConfig().extra.proxy as Record<string, string> | undefined;
  if (!proxies) return undefined;
  const site = siteOf(url);
  return (site && proxies[site]) || proxies['*'] || undefined;
}

/**
 * Connections stay open for a minute after use (Node's default is 4 s): most sites here are far
 * away, and a new TLS connection to them costs over a second. Searches, opening a result and the
 * parallel ranges of a download all reuse them.
 */
const KEEP_ALIVE = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 10 * 60_000 };

/** fetch that goes through the configured per-site proxy. Drop-in for the global fetch. */
export function proxiedFetch(url: string, init: RequestInit = {}, opts: { insecure?: boolean } = {}): Promise<Response> {
  const proxy = proxyFor(url);
  const key = `${proxy ?? 'direct'}|${opts.insecure ? 'insecure' : 'strict'}`;
  let agent = agents.get(key);
  if (!agent) {
    const tls = opts.insecure ? { rejectUnauthorized: false } : undefined;
    agent = proxy ? new ProxyAgent({ uri: proxy, requestTls: tls, ...KEEP_ALIVE }) : new Agent({ connect: tls, ...KEEP_ALIVE });
    agents.set(key, agent);
  }
  return undiciFetch(url, { ...(init as object), dispatcher: agent }) as unknown as Promise<Response>;
}

/**
 * Open connections to `urls` in the background (DNS + TLS), so the first real request to each
 * site doesn't pay for it. Errors are ignored.
 */
export function warmUp(urls: string[]): void {
  for (const url of urls) {
    proxiedFetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string | URLSearchParams | Uint8Array<ArrayBuffer>;
  jar?: CookieJar;
  signal?: AbortSignal;
  /** ms, default 20s */
  timeout?: number;
  /** extra attempts on network errors and 5xx, default 2 */
  retries?: number;
  redirect?: RequestRedirect;
  /** Skip TLS certificate checks (book sources only, as Legado does: many novel sites have broken certs). */
  insecure?: boolean;
}

export function withQuery(url: string, query?: RequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.href;
}

/** fetch with UA, cookie jar, timeout, and retries on transient failures. Throws HttpError on non-2xx. */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const full = withQuery(url, opts.query);
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { 'user-agent': UA, ...opts.headers };
    if (opts.jar) {
      const c = opts.jar.header();
      if (c) headers.cookie = headers.cookie ? `${headers.cookie}; ${c}` : c;
    }
    const signals = [AbortSignal.timeout(opts.timeout ?? 20_000)];
    if (opts.signal) signals.push(opts.signal);
    try {
      const res = await proxiedFetch(full, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers,
        body: opts.body,
        signal: AbortSignal.any(signals),
        redirect: opts.redirect ?? 'follow',
      }, { insecure: opts.insecure });
      opts.jar?.absorb(res);
      if (res.status >= 500 && attempt < retries) {
        await backoff(attempt, opts.signal);
        continue;
      }
      if (!res.ok && !(opts.redirect === 'manual' && res.status >= 300 && res.status < 400)) {
        throw new HttpError(res.status, full);
      }
      return res;
    } catch (err) {
      if (opts.signal?.aborted || err instanceof HttpError || attempt >= retries) throw err;
      await backoff(attempt, opts.signal);
    }
  }
}

export async function getJson<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
  const res = await request(url, opts);
  return (await res.json()) as T;
}

export async function getText(url: string, opts?: RequestOptions): Promise<string> {
  const res = await request(url, opts);
  return res.text();
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 400 * 2 ** attempt);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
