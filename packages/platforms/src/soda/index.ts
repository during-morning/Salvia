import { FatalError, getJson, request } from '@salvia/core';
import type { Lyrics, MusicProvider, Track } from '@salvia/music';
import { cleanText, timedToLrc } from '@salvia/music';

/**
 * 汽水音乐 (Douyin's music app; protocol as in guohuiyuan/music-lib, reimplemented): search, song
 * links, word-timed lyrics. Its audio is CENC-encrypted (DRM), which Salvia doesn't break, so —
 * like Spotify — the sound comes from the same song on the user's own NetEase/QQ account or a
 * YouTube match.
 */

const APP_UA = 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)';

interface Image {
  uri?: string;
  urls?: string[];
  template_prefix?: string;
}
interface SodaTrack {
  id?: string;
  name?: string;
  duration?: number;
  artists?: { name?: string }[];
  album?: { id?: string; name?: string; url_cover?: Image };
}

export function coverUrl(img?: Image): string | undefined {
  const base = img?.urls?.[0];
  if (!base) return undefined;
  if (img?.uri && img.template_prefix) return `${base.replace(/\/$/, '')}/${img.uri}~${img.template_prefix}-resize:960:960.png`;
  return img?.uri && !base.includes(img.uri) ? `${base}${img.uri}~c5_375x375.jpg` : base;
}

function toTrack(t: SodaTrack): Track | undefined {
  if (!t.id || !t.name) return undefined;
  return {
    id: t.id,
    source: 'soda',
    title: cleanText(t.name),
    artists: (t.artists ?? []).map((a) => cleanText(a.name)).filter(Boolean),
    album: cleanText(t.album?.name) || undefined,
    duration: t.duration ? Math.round(t.duration / 1000) : undefined,
    cover: coverUrl(t.album?.url_cover),
  };
}

async function search(query: string, signal?: AbortSignal): Promise<Track[]> {
  const params = new URLSearchParams({
    q: query,
    cursor: '0',
    count: '20',
    aid: '386088',
    device_platform: 'android',
    os: 'android',
    app_name: 'luna',
    version_code: '100198030',
    version_name: '19.8.0',
  });
  const r = await getJson<{ result_groups?: { data?: { entity?: { track?: SodaTrack } }[] }[] }>(`https://api.qishui.com/luna/search/track?${params}`, {
    headers: { 'user-agent': APP_UA },
    signal,
  });
  return (r.result_groups?.[0]?.data ?? []).map((d) => toTrack(d.entity?.track ?? {})).filter((t): t is Track => !!t);
}

async function seoTrack(id: string, signal?: AbortSignal) {
  return getJson<{ seo_track?: { track?: SodaTrack; lyric?: { content?: string } }; lyric?: { content?: string } }>(
    `https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${id}&device_platform=web`,
    { signal },
  );
}

async function lyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  const r = await seoTrack(t.id, signal);
  const raw = r.seo_track?.lyric?.content || r.lyric?.content;
  const lrc = raw ? timedToLrc(raw) : '';
  return lrc ? { lrc } : undefined;
}

export const soda: MusicProvider = {
  source: 'soda',
  name: '汽水音乐',
  matchOnly: true,
  async list(url, signal) {
    let target = url;
    // Share links (qishui.douyin.com/s/…) redirect to the track page.
    if (/qishui\.douyin\.com\/s\//.test(url)) {
      const res = await request(url, { redirect: 'manual', signal, retries: 1 });
      await res.body?.cancel();
      target = res.headers.get('location') ?? url;
    }
    const id = target.match(/track\/(\d+)/)?.[1] ?? target.match(/track_id=(\d+)/)?.[1];
    if (!id) throw new FatalError('没有识别出汽水音乐的歌曲编号。');
    const t = toTrack((await seoTrack(id, signal)).seo_track?.track ?? {});
    if (!t) throw new FatalError('歌曲不存在。');
    return { title: t.title, kind: 'track', tracks: [t] };
  },
  search,
  lyrics,
};
