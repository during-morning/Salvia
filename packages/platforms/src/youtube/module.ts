import type { SalviaModule } from '@salvia/core';
import { AUDIO_MATCHERS, MUSIC_PROVIDERS } from '@salvia/music';
import { VIDEO_SOURCES } from '@salvia/video';
import { visitorData } from './innertube.ts';
import { youtubeMatcher, youtubeMusic } from './music.ts';
import { youtubeInfo, youtubeListing, youtubeSearch } from './video.ts';

/** YouTube：视频、音频、歌曲匹配。 */
export const youtubeModule: SalviaModule = {
  id: 'youtube',
  setup(api) {
    api.host({ pattern: /(^|\.)youtube\.com$/i, kind: 'video', site: 'youtube' });
    api.host({ pattern: /(^|\.)youtu\.be$/i, kind: 'video', site: 'youtube' });
    api.id({ pattern: /^(?=[\w-]*[A-Za-z_-])[\w-]{11}$/, kind: 'video', site: 'youtube', link: (id) => `https://www.youtube.com/watch?v=${id}`, platform: 'youtube', bare: 5, label: 'YouTube 视频号' });
    api.platform({ type: 'video', id: 'youtube', name: 'YouTube', aliases: ['yt'] });
    // A channel handle: its uploads.
    api.id({ pattern: /^@[\w.-]{3,}$/, kind: 'video', site: 'youtube', link: (h) => `https://www.youtube.com/${h}`, platform: 'youtube', label: 'YouTube @频道' });
    api.platform({ type: 'music', id: 'youtube', name: 'YouTube', aliases: ['yt'] });
    api.site({
      id: 'youtube',
      name: 'YouTube',
      hosts: /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/,
      probe: 'https://www.youtube.com/generate_204',
      prewarm: ['https://www.youtube.com/'],
    });
    api.provide(VIDEO_SOURCES, {
      id: 'youtube',
      name: 'YouTube',
      site: 'youtube',
      list: youtubeListing,
      search: (q, signal) => youtubeSearch(q, signal, 20),
      link: (id) => `https://www.youtube.com/watch?v=${id}`,
      info: (hit, signal) => youtubeInfo(hit.id, signal),
      // YouTube throttles single long streams: pieces under 10 MB.
      chunk: 9 * 1024 * 1024,
      standIn: 'bilibili',
    });
    api.provide(MUSIC_PROVIDERS, youtubeMusic);
    api.provide(AUDIO_MATCHERS, youtubeMatcher);
    api.warm(() => void visitorData().catch(() => {}));
  },
};
