import type { SalviaModule } from '@salvia/core';
import { musicHandler } from './handler.ts';
import { matchers, providers } from './providers.ts';

export type { AudioMatcher, Lyrics, MusicProvider, Quality, Source, Track, TrackList } from './model.ts';
export { artistLine } from './model.ts';
export { acceptable, confident, rank, ratio, scoreCandidate, slug, type Candidate, type Scored } from './match.ts';
export * from './util.ts';
export { AUDIO_MATCHERS, MUSIC_PROVIDERS, byPlatform, providerOf, providers, matchers, searchProviders } from './providers.ts';
export { exactMatch, exactSame, norm } from './exact.ts';
export { plainLyrics } from './lyrics.ts';
export { rankSearch } from './lists.ts';
export { musicHandler } from './handler.ts';

/**
 * The music feature: searches and links of every registered platform (`MUSIC_PROVIDERS`), audio for
 * metadata-only ones from accounts, video matches (`AUDIO_MATCHERS`) or exact matches, and the
 * music settings.
 */
export const musicModule: SalviaModule = {
  id: 'music',
  setup(api) {
    api.handler(musicHandler);
    api.platform({ type: 'music', id: 'all', name: '所有音乐平台', aliases: ['全部'] });
    api.setting({
      key: 'musicSearch',
      group: '偏好',
      label: '@music 默认搜索',
      default: 'main',
      get options() {
        const main = providers().filter((p) => p.defaultSearch && p.searchable?.() !== false).map((p) => p.name);
        return [
          { value: 'main', label: `主流平台（${main.join('、')}）` },
          { value: 'all', label: '全部平台' },
        ];
      },
    });
    api.setting({
      key: 'musicQuality',
      group: '偏好',
      label: '批量下载的音质',
      default: 'best',
      options: [
        { value: 'best', label: '最高音质' },
        { value: 'mp3', label: 'MP3' },
      ],
    });
    api.setting({
      key: 'matchSource',
      group: '偏好',
      label: '只有歌曲信息的平台（Spotify 等），音频来自',
      default: 'auto',
      get options() {
        const ms = [...matchers()].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
        const auto = ms.length > 1 ? `自动（${ms[0]!.name}；不可达时用 ${ms[1]!.name}）` : '自动';
        return [
          { value: 'auto', label: auto },
          ...ms.map((m) => ({ value: m.id, label: m.name })),
          { value: 'exact', label: '只用歌名和歌手完全一致的音乐平台' },
        ];
      },
    });
  },
};
