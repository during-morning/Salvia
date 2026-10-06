import { describe, expect, it } from 'vitest';
import { matchCatalog } from '@salvia/anime';
import { mixinKey, signWbi, wbiKeyFromUrl } from '../src/bilibili/wbi.ts';
import { parseBangumi } from '../src/bilibili/pgc.ts';
import { parseBili } from '../src/bilibili/video.ts';
import { filesOf, parseDouyin } from '../src/douyin/api.ts';
import { infoHash, parseRelease, parseSize } from '../src/bt/sources.ts';

describe('wbi', () => {
  // Reference vector from SocialSisterYi/bilibili-API-collect (docs/misc/sign/wbi.md)
  it('matches the documented example', () => {
    const img = wbiKeyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png');
    const sub = wbiKeyFromUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png');
    const key = mixinKey(img, sub);
    expect(key).toBe('ea1db124af3c7062474693fa704f4ff8');
    expect(signWbi({ foo: '114', bar: '514', zab: 1919810 }, key, 1702204169)).toBe(
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    );
  });

  it("strips !'()* from values", () => {
    expect(signWbi({ q: "a!b'(c)*" }, 'k', 1)).toMatch(/^q=abc&wts=1&w_rid=/);
  });
});

describe('parseBili', () => {
  it.each([
    ['BV1xx411c7mD', { bvid: 'BV1xx411c7mD' }],
    ['https://www.bilibili.com/video/BV1Wt411x7Q3?p=2&spm=x', { bvid: 'BV1Wt411x7Q3', page: 2 }],
    ['https://www.bilibili.com/video/av170001/', { aid: 170001 }],
    ['av2', { aid: 2 }],
  ])('%s', async (input, want) => {
    expect(await parseBili(input)).toEqual({ page: undefined, ...want });
  });

  it('rejects courses; 番剧 links are seasons', async () => {
    await expect(parseBili('https://www.bilibili.com/cheese/play/ep1')).rejects.toThrow('课程');
    expect(parseBangumi('https://www.bilibili.com/bangumi/play/ep733316')).toEqual({ ep: 733316 });
    expect(parseBangumi('https://www.bilibili.com/bangumi/play/ss45969?spm=1')).toEqual({ ss: 45969 });
    expect(parseBangumi('https://www.bilibili.com/bangumi/media/md28339735')).toEqual({ md: 28339735 });
    expect(parseBangumi('https://www.bilibili.com/video/BV1xx411c7mD')).toBeUndefined();
  });

  it('matches a Bangumi title to its B站 season by Chinese or original name', () => {
    const seasons = [
      { source: 'bilibili', id: '1', title: '葬送的芙莉莲 第二季' },
      { source: 'bilibili', id: '2', title: '葬送的芙莉莲', original: '葬送のフリーレン' },
    ];
    expect(matchCatalog({ name: '葬送のフリーレン', name_cn: '葬送的芙莉莲' }, seasons).map((e) => e.id)).toEqual(['2']);
    expect(matchCatalog({ name: '葬送のフリーレン 第2期', name_cn: '葬送的芙莉莲 第二季' }, seasons).map((e) => e.id)).toEqual(['1']);
    expect(matchCatalog({ name: 'Other', name_cn: '别的' }, seasons)).toEqual([]);
  });

  it('Douyin: share text, video / note / modal links, creator pages; no-watermark addresses', async () => {
    expect(await parseDouyin('https://www.douyin.com/video/7126745726494821640')).toEqual({ kind: 'post', id: '7126745726494821640' });
    expect(await parseDouyin('https://www.douyin.com/note/7300000000000000001')).toEqual({ kind: 'post', id: '7300000000000000001' });
    expect(await parseDouyin('https://www.douyin.com/jingxuan?modal_id=7660875690212492466')).toEqual({ kind: 'post', id: '7660875690212492466' });
    expect(await parseDouyin('https://www.douyin.com/user/MS4wLjABAAAAOvioo0i30_OzEXHT92k5')).toEqual({ kind: 'user', secUid: 'MS4wLjABAAAAOvioo0i30_OzEXHT92k5' });
    const f = filesOf({
      aweme_id: '1',
      video: { bit_rate: [{ play_addr: { height: 720, url_list: ['https://c/play/y'] } }, { play_addr: { height: 1080, width: 1080, url_list: ['https://a/playwm/x'], data_size: 9 } }] },
      music: { title: '原声', play_url: { url_list: ['https://m/x.mp3'] } },
    });
    expect(f.video.map((v) => [v.label, v.url])).toEqual([
      ['1080p · mp4', 'https://a/play/x'],
      ['720p · mp4', 'https://c/play/y'],
    ]);
    expect(f.music?.url).toBe('https://m/x.mp3');
    const img = filesOf({ aweme_id: '2', images: [{ url_list: ['https://i/a.webp', 'https://i/a.jpeg'] }] });
    expect(img.images.map((i) => [i.url, i.ext])).toEqual([['https://i/a.jpeg', 'jpeg']]);
    expect(img.video).toEqual([]);
  });
});

describe('anime BT releases', () => {
  it('reads group, episode, resolution and subtitles from release titles', async () => {
    expect(parseRelease('[7³ACG] 葬送的芙莉莲/Sousou no Frieren S01 | 01-28+SPx11 [简繁字幕] BDrip 1080p x265')).toEqual({ group: '7³ACG', episode: '01-28', resolution: '1080p', subtitle: '简繁' });
    expect(parseRelease('[LoliHouse] 葬送的芙莉莲 / Sousou no Frieren - 05 [WebRip 1080p HEVC-10bit AAC][简繁内封字幕]')).toMatchObject({ group: 'LoliHouse', episode: '05', resolution: '1080p', subtitle: '简繁 · 内封' });
    expect(parseRelease('【喵萌奶茶屋】★10月新番★[葬送的芙莉莲][12][1080p][简日双语]')).toMatchObject({ group: '喵萌奶茶屋', episode: '12', resolution: '1080p', subtitle: '简' });
    expect(parseRelease('[Shiniori-Raws]葬送的芙莉莲 第二季 4k 2160p')).toMatchObject({ resolution: '2160p', episode: undefined });
    expect(parseRelease('某字幕组 葬送的芙莉莲 第03话 720P 繁体')).toMatchObject({ episode: '03', resolution: '720p', subtitle: '繁' });
  });

  it('turns base32 magnet hashes into hex and reads sizes', async () => {
    expect(infoHash('magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=x')).toBe('08ada5a7a6183aae1e09d831df6748d566095a10');
    expect(infoHash('magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ')).toBe('08ada5a7a6183aae1e09d831df6748d566095a10');
    expect(parseSize('xxx[48.5GB]')).toBe(Math.round(48.5 * 1024 ** 3));
    expect(parseSize('1.2 GiB')).toBe(Math.round(1.2 * 1024 ** 3));
  });
});
