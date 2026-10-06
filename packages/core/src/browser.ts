import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, salviaHome } from './config.ts';
import { FatalError } from './queue.ts';
import { registry } from './registry.ts';

/**
 * Sign in through a real browser window and keep the site's cookies.
 *
 * Starts the Chrome or Edge already on the machine with its own profile under ~/.salvia (the
 * user's everyday profile is never touched) and DevTools on a local port, opens the login page, and
 * polls the cookie store until the login cookie shows up. Then the window closes and the cookies of
 * that site are returned. Nothing is bundled: every Windows has Edge.
 */

export interface LoginSite {
  /** Shown to the user. */
  name: string;
  /** Where the cookie is kept (`loadConfig().cookies[cookie]`, also `@cookie <site>`). */
  cookie: string;
  url: string;
  /** Cookies of these domains (and their subdomains) are kept. */
  domains: string[];
  /** Signed in once any of these cookies exists. */
  needs: string[];
  /** What to do on the page, when it isn't obvious. */
  hint?: string;
  /** Said after a successful login (what it unlocks). */
  done?: string;
}

/** The `@login` sites the installed modules registered, by id. */
export function loginSites(): ReadonlyMap<string, LoginSite> {
  return registry.logins;
}

/** `@login` id for what the user typed, or for an item's `locked.site` (a module's alias). */
export function loginName(input: string | undefined): string | undefined {
  return registry.loginId(input);
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

const TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1000;

/** Chrome / Edge / Chromium on this machine; `extra.browser` in the config overrides. */
export function findBrowser(): string | undefined {
  const custom = loadConfig().extra.browser;
  if (typeof custom === 'string' && existsSync(custom)) return custom;
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].flatMap((base) =>
          base
            ? [join(base, 'Google/Chrome/Application/chrome.exe'), join(base, 'Microsoft/Edge/Application/msedge.exe')]
            : [],
        )
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].flatMap((bin) =>
            (env.PATH ?? '').split(':').map((dir) => join(dir, bin)),
          );
  return candidates.find((p) => existsSync(p));
}

function matchesDomain(cookieDomain: string, domains: string[]): boolean {
  const d = cookieDomain.replace(/^\./, '');
  return domains.some((want) => {
    const w = want.replace(/^\./, '');
    return d === w || d.endsWith(`.${w}`);
  });
}

/** Cookie header string from the browser's cookies, longest-living value winning on duplicates. */
export function cookieHeader(cookies: Cookie[], domains: string[]): string {
  const kept = new Map<string, Cookie>();
  for (const c of cookies) {
    if (!matchesDomain(c.domain, domains)) continue;
    const prev = kept.get(c.name);
    if (!prev || c.expires > prev.expires) kept.set(c.name, c);
  }
  return [...kept.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Minimal Chrome DevTools Protocol client over the browser-level WebSocket. */
class Cdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
  closed: Promise<void>;

  private constructor(private ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.addEventListener('close', () => resolve()));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('closed'));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`无法连接浏览器调试端口 ${url}`)), { once: true });
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void {
    this.listeners.add(listener);
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Wait for Chrome to write DevToolsActivePort (port + browser target path) into the profile. */
async function devtoolsUrl(profile: string, child: ChildProcess, signal?: AbortSignal): Promise<string> {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !signal?.aborted; i++) {
    try {
      const [port, path] = readFileSync(file, 'utf8').split(/\r?\n/);
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // not written yet
    }
    if (child.exitCode !== null && child.exitCode !== 0) break;
    await sleep(100, signal);
  }
  throw new FatalError('浏览器没有启动调试端口。关闭所有由 Salvia 打开的浏览器窗口后再试。');
}

/** Start the browser on Salvia's own profile with DevTools on a local port. */
async function launch(args: string[], signal?: AbortSignal): Promise<Cdp> {
  const exe = findBrowser();
  if (!exe) throw new FatalError('没有找到 Chrome 或 Edge。可以用 @cookie 手动粘贴 Cookie。');
  const profile = join(salviaHome(), 'browser');
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=http://127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      ...args,
    ],
    { stdio: 'ignore', detached: false },
  );
  child.on('error', () => {});
  return Cdp.connect(await devtoolsUrl(profile, child, signal));
}

/**
 * Open `url` in a hidden window of the logged-in profile and return the first `Authorization:
 * Bearer` the page itself sends to a host matching `api` (the site's own web token, e.g. the
 * Spotify web player's). Nothing is typed or clicked; it is the session `@login` created.
 */
export async function captureBearer(url: string, api: RegExp, signal?: AbortSignal): Promise<string> {
  const cdp = await launch(['--headless=new', 'about:blank'], signal);
  try {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const found = new Promise<string>((resolve) => {
      cdp.on((method, params, sid) => {
        if (sid !== sessionId || method !== 'Network.requestWillBeSent') return;
        const req = params.request as { url: string; headers: Record<string, string> };
        const auth = req.headers.Authorization ?? req.headers.authorization;
        if (auth?.startsWith('Bearer ') && api.test(req.url)) resolve(auth.slice(7));
      });
    });
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    const timeout = sleep(30_000, signal).then(() => undefined);
    const token = await Promise.race([found, timeout]);
    if (!token) throw new FatalError('没有拿到登录凭据，可能登录已过期，请重新 @login。');
    return token;
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  }
}

/** One API request a page made, with the JSON it got back. */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  status: number;
  body: string;
}

/**
 * Load `url` in a hidden window of Salvia's browser profile and record the API calls the page
 * makes to URLs matching `api` (request headers and bodies, and their responses). Resolves when
 * `done` says enough has arrived, or `settleMs` after the last match, or at `maxMs`.
 * This reads what the public web page itself loads — the same data a visitor's browser gets.
 */
export async function captureRequests(
  url: string,
  api: RegExp,
  opts: { signal?: AbortSignal; done?: (got: CapturedRequest[]) => boolean; settleMs?: number; maxMs?: number } = {},
): Promise<CapturedRequest[]> {
  const cdp = await launch(['--headless=new', 'about:blank'], opts.signal);
  try {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const pending = new Map<string, Omit<CapturedRequest, 'status' | 'body'> & { status: number; hasPost: boolean }>();
    const got: CapturedRequest[] = [];
    let last = 0;
    let finished = false;
    let wake: () => void = () => {};
    cdp.on((method, params, sid) => {
      if (sid !== sessionId || finished) return;
      const id = params.requestId as string;
      if (method === 'Network.requestWillBeSent') {
        const req = params.request as { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean };
        if (!api.test(req.url) || req.method === 'OPTIONS') return;
        pending.set(id, { url: req.url, method: req.method, headers: req.headers, postData: req.postData, hasPost: !!req.hasPostData, status: 0 });
      } else if (method === 'Network.responseReceived') {
        const p = pending.get(id);
        if (p) p.status = (params.response as { status: number }).status;
      } else if (method === 'Network.loadingFinished') {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        void (async () => {
          const res = await cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: id }, sessionId).catch(() => undefined);
          if (!res) return;
          if (p.hasPost && p.postData === undefined) {
            p.postData = (await cdp.send<{ postData: string }>('Network.getRequestPostData', { requestId: id }, sessionId).catch(() => undefined))?.postData;
          }
          const body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          got.push({ url: p.url, method: p.method, headers: p.headers, postData: p.postData, status: p.status, body });
          last = Date.now();
          wake();
        })();
      }
    });
    await cdp.send('Network.enable', { maxPostDataSize: 65536 }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    const started = Date.now();
    const settle = opts.settleMs ?? 2500;
    const max = opts.maxMs ?? 30_000;
    while (!opts.signal?.aborted && Date.now() - started < max) {
      if (opts.done?.(got)) break;
      if (got.length && Date.now() - last > settle) break;
      await Promise.race([sleep(250, opts.signal), new Promise<void>((r) => (wake = r))]);
    }
    finished = true;
    if (opts.signal?.aborted) throw new FatalError('已取消。');
    return got;
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  }
}

/**
 * Open `site`'s login page and resolve to its cookie header once the user has signed in.
 * `onStatus` reports progress for the UI.
 */
export async function browserLogin(site: LoginSite, opts: { signal?: AbortSignal; onStatus?: (text: string) => void } = {}): Promise<string> {
  const cdp = await launch(['--new-window', site.url], opts.signal);
  opts.onStatus?.(`在打开的浏览器窗口里登录${site.name}${site.hint ? `（${site.hint}）` : ''}，登录后会自动保存`);
  let closed = false;
  void cdp.closed.then(() => (closed = true));
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (!closed && !opts.signal?.aborted && Date.now() < deadline) {
      const { cookies } = await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies').catch(() => ({ cookies: [] as Cookie[] }));
      const mine = cookies.filter((c) => matchesDomain(c.domain, site.domains));
      if (mine.some((c) => site.needs.includes(c.name) && c.value)) {
        // Let the site finish setting its other cookies (csrf tokens, uin …).
        await sleep(1500, opts.signal);
        const after = await cdp.send<{ cookies: Cookie[] }>('Storage.getCookies').catch(() => ({ cookies }));
        return cookieHeader(after.cookies, site.domains);
      }
      await sleep(POLL_MS, opts.signal);
    }
    if (opts.signal?.aborted) throw new FatalError('已取消登录。');
    if (closed) throw new FatalError('浏览器窗口已关闭，没有完成登录。');
    throw new FatalError('等待登录超时（5 分钟）。');
  } finally {
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  }
}
