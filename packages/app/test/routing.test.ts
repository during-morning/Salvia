import { beforeAll, describe, expect, it } from 'vitest';
import { detectIntent, loginName, loginSites } from '@salvia/core';
import { installAll } from '../src/index.ts';

// Routing comes from the installed modules: this tests core and the platform tables together.
beforeAll(() => installAll());

describe('detectIntent', () => {
  it.each([
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'video', 'bilibili'],
    ['【标题】 https://b23.tv/abc123 分享', 'video', 'bilibili'],
    ['BV1xx411c7mD', 'video', 'bilibili'],
    ['https://youtu.be/dQw4w9WgXcQ', 'video', 'youtube'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'youtube'],
    ['https://music.163.com/#/song?id=123', 'music', 'netease'],
    ['https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV', 'music', 'qq'],
    ['https://open.spotify.com/track/abc', 'music', 'spotify'],
    ['spotify:track:abc', 'music', 'spotify'],
  ])('%s → %s/%s', (input, kind, site) => {
    expect(detectIntent(input)).toMatchObject({ kind, site });
  });

  it('@novel / @music / @video <keyword>: aggregate search', () => {
    expect(detectIntent('@music 晴天 周杰伦')).toEqual({ kind: 'music-search', input: '晴天 周杰伦', platform: undefined });
    expect(detectIntent('@novel  诡秘之主 ')).toEqual({ kind: 'novel-search', input: '诡秘之主', platform: undefined });
    expect(detectIntent('@video lofi beats')).toEqual({ kind: 'video-search', input: 'lofi beats', platform: undefined });
    expect(detectIntent('@viedo lofi')).toMatchObject({ kind: 'video-search', input: 'lofi' }); // common typo
    expect(detectIntent('@Music x')).toMatchObject({ kind: 'music-search', input: 'x' });
  });

  it('@type:<platform> narrows the search; aliases resolve to one id', () => {
    expect(detectIntent('@music:qq-music 晴天')).toEqual({ kind: 'music-search', input: '晴天', platform: 'qq-music' });
    expect(detectIntent('@music:qq 晴天')).toMatchObject({ platform: 'qq-music' });
    expect(detectIntent('@music:163 晴天')).toMatchObject({ platform: 'netease' });
    expect(detectIntent('@video:bili 原神')).toMatchObject({ kind: 'video-search', platform: 'bilibili' });
    expect(detectIntent('@novel:维基文库 红楼梦')).toEqual({ kind: 'novel-search', input: '红楼梦', platform: '维基文库' });
    expect(detectIntent('@music:nosuch 晴天')).toEqual({ kind: 'command', input: 'music:nosuch 晴天' });
  });

  it('a search without keyword is a command (which explains)', () => {
    expect(detectIntent('@music')).toEqual({ kind: 'command', input: 'music' });
    expect(detectIntent('@music:netease')).toEqual({ kind: 'command', input: 'music:netease' });
  });

  it('@parse recognises links and bare ids by format', () => {
    expect(detectIntent('@parse BV1xx411c7mD')).toMatchObject({ kind: 'video', site: 'bilibili' });
    expect(detectIntent('@parse av170001')).toMatchObject({ kind: 'video', site: 'bilibili' });
    expect(detectIntent('@parse dQw4w9WgXcQ')).toMatchObject({ kind: 'video', site: 'youtube', input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(detectIntent('@parse 0039MnYb0qxYhV')).toMatchObject({ kind: 'music', site: 'qq', input: 'https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV' });
    expect(detectIntent('@parse 347230')).toMatchObject({ kind: 'music', site: 'netease', input: 'https://music.163.com/song?id=347230' });
    expect(detectIntent('@parse 4uLU6hMCjMI75M1A2tKUQC')).toMatchObject({ kind: 'music', site: 'spotify' });
    expect(detectIntent('@parse https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ kind: 'video', site: 'youtube' });
    expect(detectIntent('@parse:bilibili 170001')).toMatchObject({ kind: 'video', input: 'av170001' });
    expect(detectIntent('@parse xyz')).toEqual({ kind: 'command', input: 'parse xyz' });
    expect(detectIntent('@parse')).toEqual({ kind: 'command', input: 'parse' });
  });

  it('plain text is not guessed', () => {
    expect(detectIntent('  诡秘之主 ')).toEqual({ kind: 'text', input: '诡秘之主' });
    expect(detectIntent('♪ 晴天')).toEqual({ kind: 'text', input: '♪ 晴天' });
    expect(detectIntent(':dir x')).toEqual({ kind: 'text', input: ':dir x' });
  });

  it('commands and empty', () => {
    expect(detectIntent('@dir D:/x')).toEqual({ kind: 'command', input: 'dir D:/x' });
    expect(detectIntent('   ')).toEqual({ kind: 'empty', input: '' });
  });
  it('@anime searches; Douyin links are videos, 汽水 links music', () => {
    expect(detectIntent('@anime 葬送的芙莉莲')).toEqual({ kind: 'anime-search', input: '葬送的芙莉莲', platform: undefined });
    expect(detectIntent('7.43 复制打开抖音 https://v.douyin.com/L4NpDJ6/')).toMatchObject({ kind: 'video', site: 'douyin' });
    expect(detectIntent('https://www.douyin.com/video/7126745726494821640')).toMatchObject({ kind: 'video', site: 'douyin' });
    expect(detectIntent('https://qishui.douyin.com/s/abc/')).toMatchObject({ kind: 'music', site: 'soda' });
    expect(detectIntent('@web:server 8080')).toEqual({ kind: 'command', input: 'web:server 8080' });
  });
});

describe('loginName', () => {
  it('takes the full names, old short names and common misspellings', () => {
    expect(loginName('bilibili')).toBe('bilibili');
    expect(loginName('bili')).toBe('bilibili');
    expect(loginName('qqmusic')).toBe('qqmusic');
    expect(loginName('qq')).toBe('qqmusic');
    expect(loginName('Spotifly')).toBe('spotify');
    expect(loginName('netease')).toBe('netease');
    expect(loginName('youtube')).toBeUndefined();
    expect(loginSites().get('qqmusic')!.cookie).toBe('qq');
  });
});

describe('new platforms', () => {
  it('links of the newer platforms are recognised as music', () => {
    for (const url of [
      'https://www.kugou.com/mixsong/abc.html',
      'https://www.kuwo.cn/play_detail/12345',
      'https://music.migu.cn/v3/music/song/600907000009041441',
      'https://music.91q.com/song/T10038992935',
      'https://www.jamendo.com/track/1234/x',
      'https://www.joox.com/hk/single/abc',
      'https://music.apple.com/cn/album/x/1?i=2',
    ]) {
      expect(detectIntent(url).kind, url).toBe('music');
    }
    expect(detectIntent('https://5sing.kugou.com/yc/1234.html')).toMatchObject({ kind: 'music', site: 'fivesing' });
  });
});

describe('more link and id forms', () => {
  it.each([
    // B站: 番剧 / 音频区 ids typed alone, audio links as music, spaces and lists as video.
    ['ep733316', 'video', 'bilibili', 'https://www.bilibili.com/bangumi/play/ep733316'],
    ['SS45969', 'video', 'bilibili', 'https://www.bilibili.com/bangumi/play/ss45969'],
    ['md28339735', 'video', 'bilibili', 'https://www.bilibili.com/bangumi/media/md28339735'],
    ['au10', 'music', 'bilibili', 'https://www.bilibili.com/audio/au10'],
    ['https://www.bilibili.com/audio/am10624', 'music', 'bilibili', undefined],
    ['https://space.bilibili.com/2', 'video', 'bilibili', undefined],
    ['https://www.bilibili.com/medialist/detail/ml1052622027', 'video', 'bilibili', undefined],
    // BT: magnets and the indexes' release pages.
    ['magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel', 'video', 'bt', undefined],
    ['https://mikanani.me/Home/Episode/f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19', 'video', 'bt', undefined],
    ['https://acg.rip/t/361401', 'video', 'bt', undefined],
    // Ids distinctive enough without @parse.
    ['7126745726494821640', 'video', 'douyin', 'https://www.douyin.com/video/7126745726494821640'],
    ['0c6b0e1c2f3a4b5c6d7e8f9a0b1c2d3e', 'music', 'kugou', 'https://www.kugou.com/song/#hash=0c6b0e1c2f3a4b5c6d7e8f9a0b1c2d3e'],
    ['T10038992935', 'music', 'qianqian', 'https://music.91q.com/song/T10038992935'],
    ['yc-12345', 'music', 'fivesing', 'https://5sing.kugou.com/yc/12345.html'],
    // Links of the other hosts platforms recognise.
    ['https://itunes.apple.com/cn/album/x/1?i=2', 'music', 'apple', undefined],
    ['https://5sing.kugou.com/m/detail/yc-123-1.html', 'music', 'fivesing', undefined],
    ['https://www.youtube.com/@LofiGirl', 'video', 'youtube', undefined],
  ])('%s → %s/%s', (input, kind, site, link) => {
    const i = detectIntent(input);
    expect(i).toMatchObject({ kind, site });
    if (link) expect(i.input).toBe(link);
  });

  it.each([
    ['@parse:kuwo 228908', 'music', 'kuwo', 'https://www.kuwo.cn/play_detail/228908'],
    ['@parse:咪咕 600907000009041441', 'music', 'migu', 'https://music.migu.cn/v3/music/song/600907000009041441'],
    ['@parse:jamendo 1886257', 'music', 'jamendo', 'https://www.jamendo.com/track/1886257'],
    ['@parse:apple 1440841363', 'music', 'apple', 'https://music.apple.com/cn/song/1440841363'],
    ['@parse:汽水 7330000000000000000', 'music', 'soda', 'https://www.qishui.com/track/7330000000000000000'],
    ['@parse:douyin 7126745726494821640', 'video', 'douyin', 'https://www.douyin.com/video/7126745726494821640'],
    ['@parse:youtube @LofiGirl', 'video', 'youtube', 'https://www.youtube.com/@LofiGirl'],
    ['@parse:bilibili 170001', 'video', 'bilibili', 'av170001'],
    ['@parse:netease 347230', 'music', 'netease', 'https://music.163.com/song?id=347230'],
  ])('%s', (input, kind, site, link) => {
    expect(detectIntent(input)).toEqual({ kind, site, input: link });
  });
});
