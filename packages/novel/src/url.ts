import iconv from 'iconv-lite';
import { CookieJar, FatalError, request } from '@salvia/core';
import { Analyzer } from './rule/analyze.ts';
import { evalJs, sourceObject, splitUrlOptions, withDefaultUa, type UrlOptions } from './rule/js.ts';
import { splitJs } from './rule/split.ts';
import { sourceHeaders, type BookSource } from './source.ts';

/**
 * Legado URL rules (AnalyzeUrl.kt, reimplemented): `@js:` / `<js>`, `<p1,p2,…>` page variants,
 * `{{key}}` / `{{page}}` / `{{js}}` templates, then `,{"method":…,"body":…,"charset":…,"headers":…}`.
 */

export interface UrlVars {
  key?: string;
  page?: number;
  /** Variables shared with rules (@put/@get). */
  vars?: Map<string, string>;
  /** Content for `{{rule}}` templates (e.g. the book page when building toc URLs). */
  content?: unknown;
  book?: Record<string, unknown>;
}

export interface Request {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers: Record<string, string>;
  charset?: string;
}

const jars = new Map<string, CookieJar>();

function jarFor(source: BookSource): CookieJar {
  let jar = jars.get(source.bookSourceUrl);
  if (!jar) jars.set(source.bookSourceUrl, (jar = new CookieJar()));
  return jar;
}

/**
 * Resolve a URL from a rule against the page. Rules may return several lines (the first is used)
 * and may carry Legado options after the URL (`url,{"webView":true}`), which are kept as is.
 */
export function absolute(value: string, base: string): string {
  const first = value.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!first) return '';
  const opt = first.search(/,\s*\{/);
  const url = opt < 0 ? first : first.slice(0, opt).trim();
  const rest = opt < 0 ? '' : first.slice(opt);
  if (/^(https?:|data:)/i.test(url)) return url + rest;
  try {
    return new URL(url, base).href + rest;
  } catch {
    return first;
  }
}

/** Links in a chapter list that aren't chapters: in-page anchors and javascript: handlers. */
export function isNavLink(url: string, pageUrl: string): boolean {
  if (/^javascript:/i.test(url)) return true;
  try {
    const u = new URL(url);
    const p = new URL(pageUrl);
    // A bare "#" leaves `hash` empty, so look at the text too.
    const anchored = u.hash !== '' || url.endsWith('#');
    return anchored && u.origin + u.pathname + u.search === p.origin + p.pathname + p.search;
  } catch {
    return false;
  }
}

/** Percent-encode one query/form value in `charset`, leaving already-encoded values alone. */
export function encodeValue(value: string, charset = 'utf-8'): string {
  if (/%[0-9A-Fa-f]{2}/.test(value) && !/[^\x20-\x7e]/.test(value)) return value;
  if (/^utf-?8$/i.test(charset)) return encodeURIComponent(value);
  return [...iconv.encode(value, charset)]
    .map((b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
}

function encodeForm(form: string, charset?: string): string {
  return form
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i < 0) return pair;
      return `${pair.slice(0, i)}=${encodeValue(pair.slice(i + 1), charset)}`;
    })
    .join('&');
}

export function buildRequest(source: BookSource, rule: string, v: UrlVars = {}): Request {
  const base = source.bookSourceUrl;
  const analyzer = new Analyzer(v.content ?? '', base, v.vars ?? new Map(), {
    key: v.key ?? '',
    page: v.page ?? 1,
    book: v.book ?? {},
    source: sourceObject(source, v.vars ?? new Map()),
  });

  // JS pieces turn the rule into the final URL spec.
  let spec = '';
  for (const seg of splitJs(rule.trim())) {
    spec = seg.kind === 'js' ? String(evalJs(seg.text, analyzer, { ...analyzer.bindings, result: spec, baseUrl: base })) : spec + seg.text;
  }

  // <first,second,…> picks by page; pages past the end use the last entry.
  spec = spec.replace(/<([^<>]*,[^<>]*)>/g, (_, list: string) => {
    const items = list.split(',');
    return items[Math.min((v.page ?? 1) - 1, items.length - 1)] ?? '';
  });

  // {{key}}, {{page}}, {{js expression}}, {{rule}}
  spec = spec.replace(/\{\{([\s\S]+?)\}\}/g, (_, inner: string) => {
    const t = inner.trim();
    if (t === 'key') return v.key ?? '';
    if (t === 'page') return String(v.page ?? 1);
    if (/^(@@|@css:|@json:|@xpath:|\$\.|\/\/)/i.test(t)) return analyzer.getString(t);
    try {
      const r = evalJs(t, analyzer, { ...analyzer.bindings, baseUrl: base });
      return r === undefined || r === null ? '' : String(r);
    } catch {
      return '';
    }
  });

  const [rawUrl, opts = {} as UrlOptions] = splitUrlOptions(spec);
  if (opts.webView) throw new FatalError('这个书源需要 WebView（在浏览器里运行网页脚本），Salvia 不支持。');
  const charset = opts.charset?.trim() || undefined;
  const full = absolute(rawUrl, base);

  // Re-encode the query in the site's charset (GBK sites expect GBK percent-encoding).
  let url = full;
  const q = full.indexOf('?');
  if (q >= 0) {
    const hash = full.indexOf('#', q);
    const query = full.slice(q + 1, hash < 0 ? undefined : hash);
    url = `${full.slice(0, q)}?${encodeForm(decodeLoosely(query), charset)}${hash < 0 ? '' : full.slice(hash)}`;
  }

  const runJs = (code: string) => evalJs(code, analyzer, { ...analyzer.bindings, baseUrl: base });
  const headers: Record<string, string> = withDefaultUa({ ...sourceHeaders(source, runJs), ...(opts.headers ?? {}) }, source.bookSourceUrl);
  let body: string | undefined;
  const method = (opts.method ?? (opts.body ? 'POST' : 'GET')).toUpperCase() === 'POST' ? 'POST' : 'GET';
  if (opts.body !== undefined) {
    if (typeof opts.body === 'object') {
      body = JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    } else if (/^\s*[[{]/.test(opts.body)) {
      body = opts.body;
      headers['content-type'] ??= 'application/json';
    } else {
      body = encodeForm(opts.body, charset);
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    }
  }
  return { url, method, body, headers, charset };
}

/** Decode %XX sequences that are valid UTF-8 so they can be re-encoded in the target charset. */
function decodeLoosely(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i < 0) return pair;
      const value = pair.slice(i + 1);
      try {
        return `${pair.slice(0, i)}=${/%[0-9A-Fa-f]{2}/.test(value) && /[^\x00-\x7f]/.test(decodeURIComponent(value)) ? decodeURIComponent(value) : value}`;
      } catch {
        return pair;
      }
    })
    .join('&');
}

/** Charset from Content-Type or a <meta> tag near the top of the page. */
export function detectCharset(contentType: string | null, head: Buffer): string {
  const fromHeader = contentType?.match(/charset=([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  const ascii = head.subarray(0, 4096).toString('latin1');
  const meta = ascii.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  return meta ?? 'utf-8';
}

export interface Fetched {
  url: string;
  body: string;
}

export async function fetchRequest(source: BookSource, req: Request, signal?: AbortSignal): Promise<Fetched> {
  const res = await request(req.url, {
    method: req.method,
    body: req.body,
    headers: req.headers,
    jar: jarFor(source),
    insecure: true,
    signal,
    timeout: 20_000,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let charset = req.charset ?? detectCharset(res.headers.get('content-type'), buf);
  if (/^gb2312$/i.test(charset)) charset = 'gbk'; // gb2312 pages routinely contain GBK characters
  const body = iconv.encodingExists(charset) ? iconv.decode(buf, charset) : buf.toString('utf8');
  return { url: res.url || req.url, body };
}

export function fetchRule(source: BookSource, rule: string, v: UrlVars = {}, signal?: AbortSignal): Promise<Fetched> {
  return fetchRequest(source, buildRequest(source, rule, v), signal);
}
