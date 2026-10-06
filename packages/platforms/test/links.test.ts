import { describe, expect, it } from 'vitest';
import { parseAudio } from '../src/bilibili/audio.ts';
import { parseSpace } from '../src/bilibili/space.ts';
import { channelId } from '../src/youtube/video.ts';

describe('B站 lists and audio', () => {
  it.each([
    ['https://space.bilibili.com/2', { kind: 'up', mid: '2' }],
    ['https://space.bilibili.com/2/video', { kind: 'up', mid: '2' }],
    ['https://space.bilibili.com/686127/favlist?fid=1052622027&ftype=create', { kind: 'fav', id: '1052622027' }],
    ['https://www.bilibili.com/medialist/detail/ml1052622027', { kind: 'fav', id: '1052622027' }],
    ['https://www.bilibili.com/list/ml1052622027?oid=1', { kind: 'fav', id: '1052622027' }],
    ['https://space.bilibili.com/2/channel/collectiondetail?sid=123', { kind: 'season', mid: '2', id: '123' }],
    ['https://space.bilibili.com/2/lists/456?type=series', { kind: 'series', mid: '2', id: '456' }],
    ['https://www.bilibili.com/video/BV1xx411c7mD', undefined],
  ])('%s', (url, want) => expect(parseSpace(url)).toEqual(want));

  it('audio songs and playlists', () => {
    expect(parseAudio('https://www.bilibili.com/audio/au10')).toEqual({ kind: 'song', id: '10' });
    expect(parseAudio('https://m.bilibili.com/audio/au3600000?x=1')).toEqual({ kind: 'song', id: '3600000' });
    expect(parseAudio('https://www.bilibili.com/audio/am10624')).toEqual({ kind: 'menu', id: '10624' });
    expect(parseAudio('https://www.bilibili.com/video/BV1xx411c7mD')).toBeUndefined();
  });
});

describe('YouTube channels', () => {
  it('reads channel ids from /channel/ links without asking the site', async () => {
    expect(await channelId('https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/videos')).toBe('UCSJ4gkVC6NrvII8umztf0Ow');
    expect(await channelId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
  });
});
