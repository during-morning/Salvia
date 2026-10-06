import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import iconv from 'iconv-lite';
import { isPackaged } from '@salvia/core';
import { Jsoup, toJs } from './jsoup.ts';

/**
 * Sandbox for the JavaScript in book sources (`@js:`, `<js>…</js>`, `{{…}}`, `jsLib`).
 * Legado runs these in Rhino with `java`, `source`, `cookie`, `cache` and Java packages such as
 * `org.jsoup`; this provides the commonly used subset. This is isolation for convenience, not
 * security: like Legado, book sources are trusted code.
 */

export interface JsHost {
  /** Run a rule against the current content (java.getString / getStringList / getElements). */
  getString(rule: string): string;
  getStringList(rule: string): string[];
  getElements(rule: string): unknown[];
  vars: Map<string, string>;
  baseUrl: string;
}

export type JsBindings = Record<string, unknown>;

/**
 * Default User-Agent for sources that don't set one. Legado sends a desktop Chrome UA; some sources
 * were written against phone pages instead (Chloris uses a phone UA). Search tries desktop first and
 * falls back to the phone UA when it finds nothing; the working one is remembered per source.
 */
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const uaChoice = new Map<string, string>();

export function setSourceUa(sourceUrl: string, ua: string | undefined): void {
  if (ua) uaChoice.set(sourceUrl, ua);
  else uaChoice.delete(sourceUrl);
}

export function hasUa(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent');
}

export function withDefaultUa(headers: Record<string, string> = {}, sourceUrl?: string): Record<string, string> {
  if (hasUa(headers)) return headers;
  return { 'user-agent': (sourceUrl && uaChoice.get(sourceUrl)) || DESKTOP_UA, ...headers };
}

// Generous: scripts often make synchronous requests (java.ajax), each of which takes a moment.
const TIMEOUT_MS = 15_000;

function encode(s: string, charset = 'utf-8'): string {
  if (/^utf-?8$/i.test(charset)) return encodeURIComponent(s);
  return [...iconv.encode(s, charset)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

// ---------- synchronous HTTP (java.ajax / get / post / connect) ----------

const FETCH_SCRIPT = `
  const [url, init] = JSON.parse(process.env.SALVIA_INTERNAL_ARGS);
  fetch(url, init).then(async r => {
    const b = Buffer.from(await r.arrayBuffer());
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    process.stdout.write(JSON.stringify({ b64: b.toString('base64'), status: r.status, url: r.url, headers }));
  }).catch(e => { process.stdout.write(JSON.stringify({ error: String(e) })); });`;

/**
 * Child side of syncFetch in the packaged build, where the executable can't run `-e` scripts:
 * the CLI entry calls this when started with SALVIA_INTERNAL=fetch.
 */
export function runInternalFetch(): void {
  new Function(FETCH_SCRIPT)();
}

interface SyncResponse {
  body: string;
  status: number;
  url: string;
  headers: Record<string, string>;
}

/**
 * Legado's JS is synchronous, so requests made from it run in a child process. Slow, but only
 * scripts that build URLs or read hidden values need it.
 */
function syncFetch(url: string, opts: { method?: string; body?: string; headers?: Record<string, string>; charset?: string } = {}): SyncResponse {
  const init = { method: opts.method ?? (opts.body ? 'POST' : 'GET'), body: opts.body, headers: withDefaultUa(opts.headers) };
  // Book sites often have broken certificates (Legado ignores them too). NODE_NO_WARNINGS keeps
  // Node's TLS warning out of the terminal — the packaged exe can't take --no-warnings — and the
  // child's stderr is dropped rather than inherited, so nothing leaks into the TUI.
  const env = {
    ...process.env,
    SALVIA_INTERNAL: 'fetch',
    SALVIA_INTERNAL_ARGS: JSON.stringify([url, init]),
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    NODE_NO_WARNINGS: '1',
  };
  const args = isPackaged() ? [] : ['--no-warnings', '-e', FETCH_SCRIPT];
  const out = execFileSync(process.execPath, args, {
    env,
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString();
  const res = JSON.parse(out) as { b64?: string; error?: string; status?: number; url?: string; headers?: Record<string, string> };
  if (res.error) throw new Error(res.error);
  const buf = Buffer.from(res.b64!, 'base64');
  const charset = opts.charset || res.headers?.['content-type']?.match(/charset=([\w-]+)/i)?.[1] || 'utf-8';
  const body = iconv.encodingExists(charset) ? iconv.decode(buf, charset) : buf.toString('utf8');
  return { body, status: res.status ?? 0, url: res.url ?? url, headers: res.headers ?? {} };
}

/** Jsoup/OkHttp-like response: `.body()`, `.headers()`, `.header(n)`, `.statusCode()`, `.url()`, `.raw()`. */
function responseObject(r: SyncResponse) {
  const raw = {
    request: () => ({ url: () => r.url }),
    code: () => r.status,
    headers: () => r.headers,
    header: (n: string) => r.headers[n.toLowerCase()] ?? null,
    body: () => r.body,
    toString: () => r.body,
  };
  return {
    body: () => r.body,
    headers: () => r.headers,
    header: (n: string) => r.headers[n.toLowerCase()] ?? null,
    cookies: () => Object.fromEntries((r.headers['set-cookie'] ?? '').split(/,(?=[^;]+=)/).map((c) => c.split(';')[0]!.split('=')).filter((p) => p.length === 2)),
    statusCode: () => r.status,
    code: () => r.status,
    url: () => r.url,
    raw: () => raw,
    toString: () => r.body,
  };
}

// ---------- crypto ----------

function cipher(decrypt: boolean, data: string, key: string, transformation: string, iv: string, outEncoding?: 'base64' | 'utf8' | 'hex'): string {
  // "AES/CBC/PKCS5Padding" → aes-128-cbc (key length decides 128/192/256)
  const [alg = 'AES', mode = 'ECB'] = transformation.split('/');
  const keyBuf = Buffer.from(key);
  const name = alg.toUpperCase() === 'DESEDE' ? `des-ede3-${mode.toLowerCase()}` : alg.toUpperCase() === 'DES' ? `des-${mode.toLowerCase()}` : `${alg.toLowerCase()}-${keyBuf.length * 8}-${mode.toLowerCase()}`;
  const ivBuf = mode.toUpperCase() === 'ECB' ? null : Buffer.from(iv || '');
  if (decrypt) {
    const input = /^[0-9a-f]+$/i.test(data) && data.length % 2 === 0 ? Buffer.from(data, 'hex') : Buffer.from(data, 'base64');
    const d = createDecipheriv(name, keyBuf, ivBuf);
    return Buffer.concat([d.update(input), d.final()]).toString('utf8');
  }
  const c = createCipheriv(name, keyBuf, ivBuf);
  return Buffer.concat([c.update(data, 'utf8'), c.final()]).toString(outEncoding ?? 'base64');
}

/** Hutool-style SymmetricCrypto as exposed by newer Legado (java.createSymmetricCrypto). */
function symmetricCrypto(transformation: string, key: string, iv = '') {
  return {
    decryptStr: (data: string) => cipher(true, data, key, transformation, iv),
    decrypt: (data: string) => cipher(true, data, key, transformation, iv),
    encryptBase64: (data: string) => cipher(false, data, key, transformation, iv, 'base64'),
    encryptHex: (data: string) => cipher(false, data, key, transformation, iv, 'hex'),
    encrypt: (data: string) => cipher(false, data, key, transformation, iv, 'base64'),
  };
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10_000, 亿: 100_000_000 };

/** "一百二十三" → 123, "十五" → 15. Undefined if it isn't a Chinese number. */
export function chineseNumber(s: string): number | undefined {
  if (!s || ![...s].every((c) => c in CN_DIGIT || c in CN_UNIT)) return undefined;
  // Plain digit sequences like 二〇二四 read digit by digit.
  if (![...s].some((c) => c in CN_UNIT)) return Number([...s].map((c) => CN_DIGIT[c]).join(''));
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const c of s) {
    if (c in CN_DIGIT) digit = CN_DIGIT[c]!;
    else {
      const unit = CN_UNIT[c]!;
      if (unit >= 10_000) {
        total += (section + digit) * unit;
        section = 0;
      } else section += (digit || 1) * unit;
      digit = 0;
    }
  }
  return total + section + digit;
}

/** Legado's StringUtils.toNumChapter: "第一百二十三章 标题" → "第123章 标题". */
export function toNumChapter(title: string): string {
  return title.replace(/第([零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+)([章节回卷集部篇])/g, (m, cn: string, unit: string) => {
    const n = chineseNumber(cn);
    return n === undefined ? m : `第${n}${unit}`;
  });
}

function bodyText(body: UrlOptions['body']): string | undefined {
  return body === undefined || typeof body === 'string' ? body : JSON.stringify(body);
}

function javaObject(host: JsHost, run: (code: string) => unknown) {
  const request = (spec: string, method?: string, body?: string, headers?: Record<string, string>) => {
    const [url, opt] = splitUrlOptions(spec);
    return syncFetch(url, {
      method: method ?? opt?.method,
      body: body ?? bodyText(opt?.body),
      headers: { ...(opt?.headers ?? {}), ...(headers ?? {}) },
      charset: opt?.charset,
    });
  };
  return {
    ajax: (spec: string) => request(spec).body,
    ajaxAll: (specs: string[]) => specs.map((s) => responseObject(request(s))),
    connect: (spec: string, header?: string) => responseObject(request(spec, undefined, undefined, header ? (parseLooseJson(header) as Record<string, string>) : undefined)),
    // java.get(key) reads a variable; java.get(url, headers) makes a GET request (Legado overload).
    get: (keyOrUrl: string, headers?: Record<string, string>) =>
      headers === undefined ? (host.vars.get(keyOrUrl) ?? '') : responseObject(request(keyOrUrl, 'GET', undefined, headers)),
    head: (url: string, headers: Record<string, string> = {}) => responseObject(request(url, 'HEAD', undefined, headers)),
    post: (url: string, body: string, headers: Record<string, string> = {}) => responseObject(request(url, 'POST', body, headers)),
    put: (key: string, value: unknown) => {
      host.vars.set(key, String(value));
      return value;
    },
    getString: (rule: string) => host.getString(rule),
    getStringList: (rule: string) => host.getStringList(rule),
    getElements: (rule: string) => toJs(host.getElements(rule)) ?? toJs([]),
    getElement: (rule: string) => toJs(host.getElements(rule)[0]) ?? null,
    importScript: (url: string) => run(loadLibrary(url)),
    base64Decode: (s: string, charset = 'utf-8') => iconv.decode(Buffer.from(s, 'base64'), charset),
    base64DecodeToByteArray: (s: string) => [...Buffer.from(s, 'base64')],
    base64Encode: (s: string) => Buffer.from(s).toString('base64'),
    hexDecodeToString: (s: string) => Buffer.from(s, 'hex').toString('utf8'),
    hexEncodeToString: (s: string) => Buffer.from(s).toString('hex'),
    md5Encode: (s: string) => createHash('md5').update(s).digest('hex'),
    md5Encode16: (s: string) => createHash('md5').update(s).digest('hex').slice(8, 24),
    digestHex: (s: string, alg: string) => createHash(alg.replace('-', '').toLowerCase()).update(s).digest('hex'),
    digestBase64Str: (s: string, alg: string) => createHash(alg.replace('-', '').toLowerCase()).update(s).digest('base64'),
    HMacHex: (s: string, alg: string, key: string) => createHmac(alg.replace(/^hmac/i, '').toLowerCase(), key).update(s).digest('hex'),
    HMacBase64: (s: string, alg: string, key: string) => createHmac(alg.replace(/^hmac/i, '').toLowerCase(), key).update(s).digest('base64'),
    encodeURI: (s: string, charset?: string) => encode(s, charset),
    utf8ToGbk: (s: string) => iconv.decode(iconv.encode(s, 'gbk'), 'gbk'),
    strToBytes: (s: string, charset = 'utf-8') => [...iconv.encode(s, charset)],
    bytesToStr: (b: number[], charset = 'utf-8') => iconv.decode(Buffer.from(b), charset),
    aesDecodeToString: (s: string, key: string, t: string, iv: string) => cipher(true, s, key, t, iv),
    aesBase64DecodeToString: (s: string, key: string, t: string, iv: string) => cipher(true, s, key, t, iv),
    aesEncodeToBase64String: (s: string, key: string, t: string, iv: string) => cipher(false, s, key, t, iv, 'base64'),
    desDecodeToString: (s: string, key: string, t: string, iv: string) => cipher(true, s, key, t, iv),
    createSymmetricCrypto: (t: string, key: string, iv?: string) => symmetricCrypto(t, String(key), iv ? String(iv) : ''),
    timeFormat: (ms: number) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19),
    timeFormatUTC: (ms: number, _format: string, offset: number) =>
      new Date(Number(ms) + Number(offset ?? 0) * 3600_000).toISOString().replace('T', ' ').slice(0, 19),
    androidId: () => 'salvia0000000000',
    randomUUID: () => randomUUID(),
    getCookie: () => '',
    getVerificationCode: () => {
      throw new Error('这个书源需要输入验证码，Salvia 不支持。');
    },
    startBrowser: () => {
      throw new Error('这个书源需要打开浏览器操作，Salvia 不支持。');
    },
    startBrowserAwait: () => {
      throw new Error('这个书源需要打开浏览器操作，Salvia 不支持。');
    },
    webView: () => {
      throw new Error('这个书源需要 WebView，Salvia 不支持。');
    },
    log: (msg: unknown) => {
      if (process.env.SALVIA_DEBUG) console.error('[source js]', msg);
      return msg;
    },
    logType: () => undefined,
    toast: () => undefined,
    longToast: () => undefined,
    toNumChapter: (s: string) => toNumChapter(String(s ?? '')),
    t2s: (s: string) => s,
    s2t: (s: string) => s,
    htmlFormat: (s: string) => s,
  };
}

/** `url,{"method":"POST",…}` → [url, options] */
export function splitUrlOptions(spec: string): [string, UrlOptions | undefined] {
  const i = spec.search(/,\s*\{/);
  if (i < 0) return [spec.trim(), undefined];
  const json = spec.slice(i + 1).trim();
  try {
    return [spec.slice(0, i).trim(), parseLooseJson(json) as UrlOptions];
  } catch {
    return [spec.trim(), undefined];
  }
}

export interface UrlOptions {
  method?: string;
  body?: string | Record<string, unknown>;
  charset?: string;
  headers?: Record<string, string>;
  type?: string;
  retry?: number;
  js?: string;
  webView?: unknown;
}

/** JSON as written in sources: single quotes and unquoted keys happen. */
export function parseLooseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const fixed = s
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, v: string) => JSON.stringify(v.replace(/\\'/g, "'")))
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  }
}

// ---------- the `source` object and jsLib ----------

export interface SourceLike {
  bookSourceUrl: string;
  bookSourceName?: string;
  header?: unknown;
  jsLib?: string;
  [k: string]: unknown;
}

/** Legado's `source` binding: fields of the book source plus getKey / variables / headers. */
export function sourceObject(source: SourceLike, vars: Map<string, string>) {
  const header = typeof source.header === 'string' ? source.header : source.header ? JSON.stringify(source.header) : '';
  return {
    ...source,
    key: source.bookSourceUrl,
    header,
    getKey: () => source.bookSourceUrl,
    getTag: () => source.bookSourceName ?? '',
    getVariable: () => vars.get('__sourceVariable') ?? '',
    setVariable: (v: unknown) => vars.set('__sourceVariable', String(v ?? '')),
    get: (k: string) => vars.get(`source:${k}`) ?? '',
    put: (k: string, v: unknown) => {
      vars.set(`source:${k}`, String(v));
      return v;
    },
    getHeaderMap: () => {
      try {
        return header ? JSON.parse(header) : {};
      } catch {
        return {};
      }
    },
    getLoginInfo: () => '',
    getLoginInfoMap: () => ({}),
    getLoginHeader: () => '',
  };
}

const libraryCache = new Map<string, string>();

/** Fetch a script library once per run (jsLib entries can be URLs). */
function loadLibrary(url: string): string {
  let code = libraryCache.get(url);
  if (code === undefined) {
    code = syncFetch(url).body;
    libraryCache.set(url, code);
  }
  return code;
}

/** jsLib is either plain JS, or a JSON object of name → library URL. */
function libraryCode(jsLib: string): string {
  const t = jsLib.trim();
  if (t.startsWith('{')) {
    try {
      const map = JSON.parse(t) as Record<string, string>;
      return Object.values(map)
        .map((u) => (/^https?:/.test(u) ? loadLibrary(u) : u))
        .join('\n;\n');
    } catch {
      // not JSON after all: treat as code
    }
  }
  return t;
}

/**
 * One context per jsLib, so a library (often CryptoJS-sized) is evaluated once rather than on
 * every call. Without a jsLib each call gets a fresh context.
 */
const libContexts = new Map<string, vm.Context>();

function contextFor(jsLib: string | undefined): vm.Context {
  if (!jsLib?.trim()) return vm.createContext({});
  let ctx = libContexts.get(jsLib);
  if (!ctx) {
    ctx = vm.createContext({});
    Object.assign(ctx, baseGlobals(undefined));
    try {
      vm.runInContext(libraryCode(jsLib), ctx, { timeout: TIMEOUT_MS, displayErrors: false });
    } catch {
      // a broken library shouldn't take the whole source down; scripts that need it will fail
    }
    libContexts.set(jsLib, ctx);
  }
  return ctx;
}

/** Java-ish globals Rhino scripts reach for. */
function baseGlobals(host: JsHost | undefined) {
  return {
    org: { jsoup: { Jsoup } },
    Packages: { org: { jsoup: { Jsoup } } },
    cookie: {
      getCookie: () => '',
      getKey: () => '',
      setCookie: () => undefined,
      replaceCookie: () => undefined,
      removeCookie: () => undefined,
    },
    cache: host
      ? {
          get: (k: string) => host.vars.get(`cache:${k}`) ?? null,
          put: (k: string, v: unknown) => host.vars.set(`cache:${k}`, String(v)),
          getFromMemory: (k: string) => host.vars.get(`cache:${k}`) ?? null,
          putMemory: (k: string, v: unknown) => host.vars.set(`cache:${k}`, String(v)),
        }
      : undefined,
  };
}

/** Evaluate source JS. The value of the last expression is returned (Rhino semantics). */
export function evalJs(code: string, host: JsHost, bindings: JsBindings = {}): unknown {
  const source = bindings.source as SourceLike | undefined;
  const ctx = contextFor(typeof source?.jsLib === 'string' ? source.jsLib : undefined);
  const run = (c: string) => vm.runInContext(c, ctx, { timeout: TIMEOUT_MS, displayErrors: false });
  Object.assign(ctx, baseGlobals(host), { java: javaObject(host, run), baseUrl: host.baseUrl }, bindings);
  return run(code);
}
