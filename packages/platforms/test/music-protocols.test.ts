import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { jamCall } from '../src/jamendo/index.ts';
import { decodeKrc } from '../src/kugou/index.ts';
import { parseMinfo } from '../src/kuwo/index.ts';
import { signed } from '../src/qianqian/index.ts';
import { coverUrl } from '../src/soda/index.ts';
import { md5, sha1, timedToLrc } from '@salvia/music';

describe('platform protocols', () => {
  it('Kugou KRC: 4-byte header, XOR key, deflate', () => {
    const key = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
    const text = '[1000,2000]<0,500,0>晴<500,500,0>天';
    const body = deflateSync(Buffer.from(text, 'utf8')).map((b, i) => b ^ key[i % key.length]!);
    const krc = Buffer.concat([Buffer.from('krc1'), body]).toString('base64');
    expect(decodeKrc(krc)).toBe(text);
    expect(timedToLrc(decodeKrc(krc))).toBe('[00:01.00]晴天');
  });

  it('timed lyrics keep plain LRC lines and drop the rest', () => {
    expect(timedToLrc('[ti:晴天]\n[00:02.50]故事的小黄花\n[63000,1000]<0,1,0>从')).toBe('[00:02.50]故事的小黄花\n[01:03.00]从');
  });

  it('Kuwo MINFO lists formats with sizes', () => {
    const f = parseMinfo('level:ff,bitrate:2000,format:flac,size:25.81Mb;level:p,bitrate:320,format:mp3,size:9.43Mb');
    expect(f.map((x) => [x.format, x.bitrate])).toEqual([
      ['flac', 2000],
      ['mp3', 320],
    ]);
    expect(f[1]!.size).toBe(Math.round(9.43 * 1024 * 1024));
  });

  it('Qianqian signs the sorted query with the app secret', () => {
    const q = signed({ word: '晴天', type: '1' }, 1_700_000_000_000);
    expect(q.get('timestamp')).toBe('1700000000');
    expect(q.get('appid')).toBe('16073360');
    expect(q.get('sign')).toBe(md5('appid=16073360&timestamp=1700000000&type=1&word=晴天0b50b02fd0d73a9c4c8c3a781c30845f'));
  });

  it('Jamendo x-jam-call is sha1(path + random)', () => {
    expect(jamCall('/api/search', '0.5')).toBe(`$${sha1('/api/search0.5')}*0.5~`);
  });

  it('Soda cover from its image template', () => {
    expect(coverUrl({ urls: ['https://p3.example.com/'], uri: 'tos/abc', template_prefix: 'tplv-x' })).toBe('https://p3.example.com/tos/abc~tplv-x-resize:960:960.png');
    expect(coverUrl(undefined)).toBeUndefined();
  });
});

