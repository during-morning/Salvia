import { describe, expect, it } from 'vitest';
import { RateLimiter, serverInputFilter } from '../src/guard.ts';

describe('server mode', () => {
  it('rate limits searches per address and refills over time', () => {
    const rl = new RateLimiter(1, 3, 10, 40);
    const t = 1_000_000;
    expect([0, 1, 2].map(() => rl.take('a', true, t))).toEqual([undefined, undefined, undefined]);
    expect(rl.take('a', true, t)).toBeGreaterThan(0);
    // Another address has its own budget; reading the view is separate.
    expect(rl.take('b', true, t)).toBeUndefined();
    expect(rl.take('a', false, t)).toBeUndefined();
    expect(rl.take('a', true, t + 1100)).toBeUndefined();
  });

  it('blocks an address that keeps hammering', () => {
    const rl = new RateLimiter(1, 1, 10, 40);
    const t = 5_000_000;
    rl.take('x', true, t);
    let wait: number | undefined;
    for (let i = 0; i < 25; i++) wait = rl.take('x', true, t);
    expect(wait).toBe(60);
    expect(rl.take('x', false, t + 30_000)).toBeGreaterThan(0);
  });

  it('keeps logins, settings and book sources off the network', () => {
    for (const cmd of ['@login bilibili', '@cookie qq x', '@setting theme mint', '@source add http://x', '@dir /', '@web:server quit', '@proxy * http://x']) {
      expect(serverInputFilter(cmd), cmd).toBeTruthy();
    }
    for (const ok of ['@music 晴天', '@video lofi', 'https://b23.tv/x', '@novel 红楼梦', '@help']) expect(serverInputFilter(ok), ok).toBeUndefined();
  });
});
