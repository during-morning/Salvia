import { describe, expect, it } from 'vitest';
import { parseNetease } from '../src/netease/index.ts';
import { parseQQ, searchId } from '../src/qq/index.ts';
import { parseSpotify } from '../src/spotify/index.ts';

describe('url parsing', () => {
  it.each([
    ['https://music.163.com/#/song?id=347230', { type: 'song', id: '347230' }],
    ['https://music.163.com/song?id=347230&userid=1', { type: 'song', id: '347230' }],
    ['https://music.163.com/#/playlist?id=3778678', { type: 'playlist', id: '3778678' }],
    ['https://y.music.163.com/m/album?id=18905', { type: 'album', id: '18905' }],
    ['https://music.163.com/#/discover/toplist?id=3778678', { type: 'playlist', id: '3778678' }],
  ])('netease %s', async (url, want) => expect(await parseNetease(url)).toEqual(want));

  it.each([
    ['https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV', { type: 'song', id: '0039MnYb0qxYhV' }],
    ['https://y.qq.com/n/ryqq/albumDetail/000MkMni19ClKG', { type: 'album', id: '000MkMni19ClKG' }],
    ['https://y.qq.com/n/ryqq/playlist/7256912512', { type: 'playlist', id: '7256912512' }],
    ['https://i.y.qq.com/n2/m/share/details/taoge.html?id=7256912512', { type: 'playlist', id: '7256912512' }],
  ])('qq %s', async (url, want) => expect(await parseQQ(url)).toEqual(want));

  it.each([
    ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=1', { kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }],
    ['https://open.spotify.com/intl-zh/album/4yP0hdKOZPNshxUOjY0cZj', { kind: 'album', id: '4yP0hdKOZPNshxUOjY0cZj' }],
    ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' }],
  ])('spotify %s', async (url, want) => expect(await parseSpotify(url)).toEqual(want));
});

describe('QQ search id', () => {
  it('is 3·2^54 + a multiple of 2^32 + milliseconds of the day, like the web player', () => {
    const at = new Date(2026, 0, 1, 1, 2, 3, 4); // 3723004 ms into the day
    expect(searchId(at, 0)).toBe((3n * 18014398509481984n + 3723004n).toString());
    expect(searchId(at, 1)).toBe((3n * 18014398509481984n + 4194304n * 4294967296n + 3723004n).toString());
  });
});
