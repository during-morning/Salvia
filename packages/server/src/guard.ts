import { EventEmitter } from 'node:events';
import type { Session } from '@salvia/core';

/**
 * Server mode (`@web:server`): what the console shows (clients, requests, rate limiting, recent
 * activity) and the per-IP request budget.
 */
export interface LogLine {
  at: number;
  ip: string;
  text: string;
  tone?: 'ok' | 'error' | 'idle';
}

export class ServerStats extends EventEmitter<{ change: [] }> {
  readonly started = Date.now();
  requests = 0;
  limited = 0;
  /** Open event streams (browser tabs). */
  streams = 0;
  log: LogLine[] = [];
  /** Client sessions by id, with the last time each was used. */
  readonly sessions = new Map<string, { session: Session; ip: string; last: number; streams: number }>();
  private timer?: NodeJS.Timeout;

  push(ip: string, text: string, tone?: LogLine['tone']): void {
    this.log = [{ at: Date.now(), ip, text, tone }, ...this.log].slice(0, 200);
    this.changed();
  }

  /** Coalesced: progress ticks of many clients must not redraw the console each time. */
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emit('change');
    }, 250);
  }

  /** Every client's tasks. */
  tasks() {
    return [...this.sessions.values()].flatMap((s) => s.session.queue.list());
  }
}

/**
 * Token buckets per client address: searches, picks and previews (which hit the music and video
 * sites) refill slowly; reading the view is cheap. A client that keeps hitting the limit is
 * blocked for a minute.
 */
export class RateLimiter {
  private buckets = new Map<string, { heavy: number; light: number; at: number; strikes: number; blockedUntil: number }>();

  constructor(
    private readonly heavyRate = 1,
    private readonly heavyBurst = 8,
    private readonly lightRate = 10,
    private readonly lightBurst = 40,
  ) {}

  /** undefined when allowed, else the seconds to wait. */
  take(ip: string, heavy: boolean, now = Date.now()): number | undefined {
    let b = this.buckets.get(ip);
    if (!b) {
      b = { heavy: this.heavyBurst, light: this.lightBurst, at: now, strikes: 0, blockedUntil: 0 };
      this.buckets.set(ip, b);
    }
    if (b.blockedUntil > now) return Math.ceil((b.blockedUntil - now) / 1000);
    const dt = (now - b.at) / 1000;
    b.at = now;
    b.heavy = Math.min(this.heavyBurst, b.heavy + dt * this.heavyRate);
    b.light = Math.min(this.lightBurst, b.light + dt * this.lightRate);
    b.strikes = Math.max(0, b.strikes - dt / 10);
    const key = heavy ? 'heavy' : 'light';
    if (b[key] >= 1) {
      b[key] -= 1;
      return undefined;
    }
    b.strikes++;
    if (b.strikes >= 20) {
      b.blockedUntil = now + 60_000;
      b.strikes = 0;
      return 60;
    }
    return Math.ceil((1 - b[key]) / (heavy ? this.heavyRate : this.lightRate));
  }

  /** Forget idle addresses. */
  sweep(now = Date.now()): void {
    for (const [ip, b] of this.buckets) if (now - b.at > 10 * 60_000 && b.blockedUntil < now) this.buckets.delete(ip);
  }
}

/** Commands a browser may not run on a shared server: logins, settings, and book sources (trusted code). */
const SERVER_ONLY = /^@(login|cookie|web|dir|proxy|setting|ffmpeg|spotify|source)(\b|:)/i;

export function serverInputFilter(text: string): string | undefined {
  if (!SERVER_ONLY.test(text)) return undefined;
  const name = text.match(/^@([\w:]+)/)?.[1] ?? '';
  return `服务端模式下网页不能使用 @${name}：登录和设置只能在服务端控制台进行。`;
}
