import { describe, expect, it } from 'vitest';
import { zzcSign } from '../src/qq/sign.ts';
import { eapiDecrypt, eapiEncrypt } from '../src/netease/eapi.ts';
import { createHash } from 'node:crypto';

describe('zzcSign', () => {
  // Vectors computed with an independent Python implementation of the same algorithm.
  it.each([
    ['hello', 'zzcfa14dde89n1iwax0l5rimr0qwjexceiov4daaee8d6'],
    ['{"comm":{"ct":24},"req":{"module":"x"}}', 'zzca658bc8hutlyt5e5zcfnivxmm9ufxf3gb4fd8f08'],
  ])('%s', (body, want) => {
    expect(zzcSign(body)).toBe(want);
  });
});

describe('eapi', () => {
  it('round-trips and carries the md5 digest of the documented string', () => {
    const path = '/api/song/enhance/player/url/v1';
    const data = { ids: '[347230]', level: 'exhigh' };
    const hex = eapiEncrypt(path, data);
    expect(hex).toMatch(/^[0-9A-F]+$/);
    const { path: p, text, digest } = eapiDecrypt(hex);
    expect(p).toBe(path);
    expect(JSON.parse(text)).toEqual(data);
    expect(digest).toBe(createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex'));
  });
});

