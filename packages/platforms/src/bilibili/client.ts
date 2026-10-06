import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CookieJar, FatalError, HttpError, cacheDir, getJson, loadConfig, request } from '@salvia/core';
import { mixinKey, signWbi, wbiKeyFromUrl } from './wbi.ts';

export const BILI_HEADERS = {
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
};

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  /** 番剧 (pgc) APIs answer in `result` instead of `data`. */
  result?: T;
}

const DAY = 24 * 3600 * 1000;

/**
 * Bilibili API session. Unsigned endpoints get HTTP 412 (risk control) on many networks, so every
 * call goes through the wbi-signed variant with buvid3/buvid4 device cookies, as the web player does.
 */
export class BiliClient {
  jar: CookieJar;
  private ready?: Promise<void>;
  private key?: string;

  constructor() {
    this.jar = new CookieJar(loadConfig().cookies.bili);
  }

  get loggedIn(): boolean {
    return this.jar.has('SESSDATA');
  }

  /** Get the device cookies and signing keys now, so the first search doesn't wait for them. */
  warm(): void {
    this.ensure().catch(() => {});
  }

  /** Device cookies (buvid3 …) and signing keys in place, for requests made outside api(). */
  async prepared(signal?: AbortSignal): Promise<CookieJar> {
    await this.ensure(signal);
    return this.jar;
  }

  private ensure(signal?: AbortSignal): Promise<void> {
    this.ready ??= this.init(signal).catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async init(signal?: AbortSignal): Promise<void> {
    if (!this.jar.has('buvid3')) {
      const spi = await getJson<ApiResponse<{ b_3: string; b_4: string }>>(
        'https://api.bilibili.com/x/frontend/finger/spi',
        { headers: BILI_HEADERS, signal },
      );
      this.jar.set('buvid3', spi.data.b_3);
      this.jar.set('buvid4', encodeURIComponent(spi.data.b_4));
      this.jar.set('b_nut', String(Math.floor(Date.now() / 1000)));
      this.jar.set('_uuid', `${randomUUID().toUpperCase()}infoc`);
    }
    this.key = await this.wbiKey(signal);
  }

  /** img/sub keys rotate daily; cache them for a day. */
  private async wbiKey(signal?: AbortSignal): Promise<string> {
    const file = join(cacheDir('bilibili'), 'wbi.json');
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { key: string; at: number };
      if (Date.now() - cached.at < DAY) return cached.key;
    } catch {
      // refetch
    }
    const nav = await getJson<ApiResponse<{ wbi_img: { img_url: string; sub_url: string } }>>(
      'https://api.bilibili.com/x/web-interface/nav',
      { headers: BILI_HEADERS, jar: this.jar, signal },
    );
    const key = mixinKey(wbiKeyFromUrl(nav.data.wbi_img.img_url), wbiKeyFromUrl(nav.data.wbi_img.sub_url));
    writeFileSync(file, JSON.stringify({ key, at: Date.now() }));
    return key;
  }

  /** GET a wbi-signed API and unwrap `data`. Retries once with fresh device cookies on 412. */
  async api<T>(url: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ensure(signal);
      try {
        const res = await request(`${url}?${signWbi(params, this.key!)}`, { headers: BILI_HEADERS, jar: this.jar, signal });
        const body = (await res.json()) as ApiResponse<T>;
        if (body.code === -352 && attempt === 0) {
          // signature rejected: keys rotated early
          this.resetKey();
          continue;
        }
        if (body.code !== 0) throw new FatalError(biliMessage(body.code, body.message));
        return body.data ?? (body.result as T);
      } catch (err) {
        if (err instanceof HttpError && err.status === 412) {
          if (attempt === 0) {
            this.reset();
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw new FatalError('B站风控拦截（412）。可以稍后再试，或用 @login bilibili 登录自己的账号。');
        }
        throw err;
      }
    }
  }

  private resetKey(): void {
    try {
      writeFileSync(join(cacheDir('bilibili'), 'wbi.json'), '{}');
    } catch {
      // ignore
    }
    this.ready = undefined;
  }

  /** New device identity (fresh buvid) on the next call. */
  private reset(): void {
    this.jar = new CookieJar(loadConfig().cookies.bili);
    this.ready = undefined;
  }
}

function biliMessage(code: number, message: string): string {
  switch (code) {
    case -404:
    case 62002:
    case 62004:
      return '视频不存在或已被删除。';
    case -403:
    case 62012:
      return '没有权限观看这个视频（可能仅限会员或指定地区）。';
    case -10403:
      return '这个视频在当前地区不可用。';
    default:
      return `B站返回错误 ${code}：${message}`;
  }
}

let shared: { client: BiliClient; cookie: string | undefined } | undefined;

/** Shared client; rebuilt when `@cookie bili …` changes the saved login. */
export function biliClient(): BiliClient {
  const cookie = loadConfig().cookies.bili;
  if (!shared || shared.cookie !== cookie) shared = { client: new BiliClient(), cookie };
  return shared.client;
}
