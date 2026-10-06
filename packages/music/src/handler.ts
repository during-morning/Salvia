import { explainError, type Handler } from '@salvia/core';
import { rankSearch, showList } from './lists.ts';
import type { Track } from './model.ts';
import { mainlandOnly, providerOf, searchProviders } from './providers.ts';
import { showTrack } from './track.ts';

/** `@music <歌名>` (streamed, interleaved across platforms) and links to any music platform. */
export const musicHandler: Handler = {
  id: 'music',
  kinds: ['music', 'music-search'],
  match: (intent) => intent.kind === 'music-search' || (!!intent.site && !!providerOf(intent.site)),
  async handle(ctx) {
    if (ctx.intent.kind === 'music-search') {
      const { list: providers, skipped } = searchProviders(ctx.intent.platform);
      // Platforms found unreachable at start-up are left out, and said so.
      const skipNote = skipped.length ? `已跳过${skipped.map((p) => p.name).join('、')}（当前网络无法访问，可用 @proxy 设置出口）` : '';
      if (!providers.length) return ctx.status(skipNote || '没有可以搜索的音乐平台。', 'error');
      ctx.status(`在${providers.map((p) => p.name).join('、')}搜索 ${ctx.intent.input}`);
      // Each platform's results show as soon as it answers; the others join in when they do.
      const lists: Track[][] = providers.map(() => []);
      const errors: unknown[] = [];
      let answered = 0;
      const render = () => {
        if (ctx.picks) return; // a result is open: late results must not replace it
        // Interleave platforms so all show up near the top, then put originals first.
        const merged: Track[] = [];
        for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) merged.push(l[i]!);
        if (!merged.length) return;
        showList(ctx, { title: `搜索：${ctx.intent.input}`, kind: 'track', tracks: rankSearch(merged, ctx.intent.input) }, providers.length > 1);
        if (answered < providers.length) ctx.status(`${merged.length} 首 · 还在等${providers.filter((_, i) => !lists[i]!.length).map((p) => p.name).join('、')}`);
        else if (skipNote) ctx.status(`搜索：${ctx.intent.input} · ${merged.length} 首 · ${skipNote}`, 'idle');
      };
      await Promise.all(
        providers.map((p, i) =>
          p.search(ctx.intent.input, ctx.signal).then(
            (tracks) => {
              answered++;
              lists[i] = tracks;
              render();
            },
            (err) => {
              answered++;
              errors.push(err);
              render();
            },
          ),
        ),
      );
      if (ctx.signal.aborted || ctx.picks) return;
      if (!lists.some((l) => l.length)) {
        if (!errors.length) return ctx.status(['没有找到。', skipNote].filter(Boolean).join(' '), 'error');
        // Mainland platforms refuse connections from abroad: say what helps.
        const mainland = providers.every(mainlandOnly);
        return ctx.status(`${explainError(errors[0])}${mainland ? ' 这些平台通常只对中国大陆网络开放，可用 @proxy 设置国内出口。' : ''}`, 'error');
      }
      return render();
    }
    const provider = providerOf(ctx.intent.site!)!;
    ctx.status(`解析${provider.name}链接`);
    const list = await provider.list(ctx.intent.input, ctx.signal);
    if (!list.tracks.length) return ctx.status('列表是空的。', 'error');
    if (list.kind === 'track' && list.tracks.length === 1) return showTrack(ctx, list.tracks[0]!);
    showList(ctx, list);
  },
};
