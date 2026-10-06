import { saveConfig, type SalviaModule } from '@salvia/core';
import { MUSIC_PROVIDERS, type Track } from '@salvia/music';
import { spotify, spotifySearchable, spotifyTrack } from './index.ts';

/** The track's own embed page: cover, album, release date, preview clip (merged over what we have). */
async function details(t: Track, signal?: AbortSignal): Promise<Track | undefined> {
  const own = await spotifyTrack(t.id, signal).catch(() => undefined);
  return own ? { ...t, cover: t.cover ?? own.cover, album: t.album ?? own.album, extra: { ...own.extra, ...t.extra } } : undefined;
}

/** Spotify：歌曲信息（音频来自匹配）。 */
export const spotifyModule: SalviaModule = {
  id: 'spotify',
  setup(api) {
    api.host({ pattern: /(^|\.)open\.spotify\.com$/i, kind: 'music', site: 'spotify' });
    api.host({ pattern: /(^|\.)spotify\.link$/i, kind: 'music', site: 'spotify' });
    const track = (id: string) => `https://open.spotify.com/track/${id}`;
    api.id({ pattern: /^spotify:(track|album|playlist|artist):\w+$/, kind: 'music', site: 'spotify', link: (id) => id, bare: -1 });
    api.id({ pattern: /^[0-9A-Za-z]{22}$/, kind: 'music', site: 'spotify', link: track, bare: 4, label: 'Spotify id' });
    api.id({ pattern: /^\w+$/, kind: 'music', site: 'spotify', link: track, platform: 'spotify' });
    api.platform({ type: 'music', id: 'spotify', name: 'Spotify' });
    api.login(
      'spotify',
      {
        name: 'Spotify',
        cookie: 'spotify',
        url: 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F',
        domains: ['spotify.com'],
        needs: ['sp_dc'],
        done: '现在可以用 @music:spotify 搜索，并读取完整歌单',
      },
      ['spotifly'],
    );
    api.site({ id: 'spotify', name: 'Spotify', hosts: /(^|\.)(spotify\.com|scdn\.co|spotifycdn\.com)$/, prewarm: ['https://open.spotify.com/'] });
    api.provide(MUSIC_PROVIDERS, { ...spotify, site: 'spotify', defaultSearch: true, searchable: spotifySearchable, details });
    api.command({
      name: 'spotify',
      usage: '@spotify <client id> <client secret>（可选，用官方 API 读取完整歌单）',
      complete: (args) =>
        args.length === 1
          ? [{ value: '', meta: '输入 Spotify 开发者应用的 Client ID（developer.spotify.com）；更省事：@login spotify' }]
          : args.length === 2
            ? [{ value: '', meta: '输入 Client Secret' }]
            : [],
      run([id, secret], ctx) {
        const extra = { ...ctx.config.extra };
        if (id && secret) extra.spotify = { id, secret };
        else delete extra.spotify;
        saveConfig({ extra });
        ctx.status(id && secret ? '已保存 Spotify 凭据。' : '已清除 Spotify 凭据，改用公开页面数据。', 'ok');
      },
    });
  },
};
