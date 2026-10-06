import { describe, expect, it } from 'vitest';
import { parseYouTube } from '../src/youtube/video.ts';
import { buildFormats, type RawFormat } from '../src/youtube/formats.ts';
import { parseClock } from '../src/youtube/innertube.ts';

describe('parseYouTube', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { videoId: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', { videoId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', { videoId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/playlist?list=PLx', { listId: 'PLx' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', { videoId: 'dQw4w9WgXcQ' }],
  ])('%s', (url, want) => {
    expect(parseYouTube(url)).toEqual({ videoId: undefined, listId: undefined, ...want });
  });
});

const f = (itag: number, mimeType: string, extra: Partial<RawFormat> = {}): RawFormat => ({
  itag, mimeType, bitrate: itag * 1000, url: `https://x/${itag}`, contentLength: String(itag * 100), ...extra,
});

describe('buildFormats', () => {
  const formats = buildFormats([
    f(401, 'video/mp4; codecs="av01.0.12M.08"', { height: 2160 }),
    f(313, 'video/webm; codecs="vp9"', { height: 2160 }),
    f(137, 'video/mp4; codecs="avc1.640028"', { height: 1080 }),
    f(399, 'video/mp4; codecs="av01.0.08M.08"', { height: 1080 }),
    f(303, 'video/webm; codecs="vp9"', { height: 1080, fps: 60 }),
    f(140, 'audio/mp4; codecs="mp4a.40.2"'),
    f(251, 'audio/webm; codecs="opus"'),
    f(141, 'audio/mp4; codecs="mp4a.40.2"', { audioTrack: { displayName: 'dub', audioIsDefault: false } }),
    f(999, 'video/mp4; codecs="avc1"', { height: 720, url: undefined, signatureCipher: 's=1' }),
  ]);

  it('one per resolution, h264 preferred, vp9 into webm', () => {
    expect(formats.map((x) => x.label)).toEqual([
      '2160p · AV1', '1080p60 · VP9', '1080p · H.264', '仅音频 · m4a', '仅音频 · mp3',
    ]);
    expect(formats[1]).toMatchObject({ ext: 'webm', audio: { codec: 'opus' } });
    expect(formats[2]).toMatchObject({ ext: 'mp4', video: { url: 'https://x/137' }, audio: { url: 'https://x/140' } });
  });

  it('parses clock strings', () => {
    expect(parseClock('3:34')).toBe(214);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('LIVE')).toBeUndefined();
  });
});
