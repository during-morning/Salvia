import { explainError, unreachable, type Handler } from '@salvia/core';
import { enqueueVideo, openVideoLink } from './download.ts';
import { formatDuration } from './model.ts';
import { infoPreview, videoSource, videoSources, type VideoHit, type VideoSource } from './sources.ts';

type Hit = VideoHit & { source: VideoSource };

const reachableSource = (s: VideoSource) => !s.site || !unreachable(s.site);

/**
 * The sources a search asks: the one named (`@video:<id>`) or all that can search, with stand-ins
 * for sites unreachable from this network (checked at start-up).
 */
function searchSources(platform?: string): { sources: VideoSource[]; note: string } {
  const wanted = platform ? [videoSource(platform)].filter((s): s is VideoSource => !!s) : videoSources().filter((s) => s.search);
  const out: VideoSource[] = [];
  const notes: string[] = [];
  for (const s of wanted) {
    if (reachableSource(s)) {
      if (!out.includes(s)) out.push(s);
      continue;
    }
    const stand = s.standIn ? videoSource(s.standIn) : undefined;
    notes.push(`${s.name} 当前网络无法访问${stand ? `，已改用 ${stand.name}` : ''}（可用 @proxy ${s.site} 设置代理）`);
    if (stand && reachableSource(stand) && !out.includes(stand)) out.push(stand);
  }
  return { sources: out, note: notes.join('；') };
}

/** `@video <关键词>` searches every video site together (interleaved); `@video:<platform>` one of them. */
export const videoSearchHandler: Handler = {
  id: 'video-search',
  kinds: ['video-search'],
  async handle(ctx) {
    const { sources, note } = searchSources(ctx.intent.platform);
    if (!sources.length) return ctx.status(note || '没有可以搜索的视频网站。', 'error');
    ctx.status(`在${sources.map((s) => s.name).join('、')}搜索 ${ctx.intent.input}`);
    // Each site's results show as soon as it answers.
    const lists: Hit[][] = sources.map(() => []);
    const errors: unknown[] = [];
    let answered = 0;
    const many = sources.length > 1;
    const render = () => {
      if (ctx.picks) return; // a result is open: late results must not replace it
      const hits: Hit[] = [];
      for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i]) hits.push(l[i]!);
      if (!hits.length) return;
      const waiting = sources.filter((_, i) => !lists[i]!.length && answered < sources.length);
      const head = [`${hits.length} 个结果`, note].filter(Boolean).join(' · ');
      ctx.status(waiting.length ? `${head} · 还在等${waiting.map((s) => s.name).join('、')}` : head, waiting.length ? 'busy' : 'idle');
      showHits(hits);
    };
    const key = (h: Hit) => `${h.source.id}:${h.id}`;
    const showHits = (hits: Hit[]) =>
      ctx.items(
        hits.map((h) => ({
          id: key(h),
          title: h.title,
          meta: [h.channel, h.duration ? formatDuration(h.duration) : '', many ? h.source.name : ''].filter(Boolean).join(' · '),
          cells: [h.title, h.channel, h.duration ? formatDuration(h.duration) : '', h.source.name],
          selectable: !h.locked,
          // Members-only / 充电专属 / live: hidden until "显示不可用"; picking asks to log in there.
          locked: h.locked ? { reason: h.locked, site: h.source.id } : undefined,
          pick: () => openVideoLink(ctx, h.source.id, h.source.link!(h.id)),
          previewer: h.source.info ? (signal: AbortSignal) => h.source.info!(h, signal).then((info) => infoPreview(info, h, h.source.name, formatDuration)) : undefined,
        })),
        {
          columns: [
            { title: '标题', flex: 3 },
            { title: 'UP主 / 频道', flex: 1 },
            { title: '时长', width: 9, align: 'right' },
            { title: '平台', width: 8 },
          ],
          // Checked videos at their best quality.
          batch: {
            label: '下载选中',
            async run(ids) {
              const picked = ids.map((id) => hits.find((h) => key(h) === id)).filter((h): h is Hit => !!h);
              ctx.status(`准备 ${picked.length} 个下载`);
              for (const h of picked) {
                const listing = await h.source.list?.(h.source.link!(h.id), ctx.signal).catch(() => undefined);
                const entry = listing?.entries[listing.current];
                if (entry) enqueueVideo(ctx, h.source.id, entry, 'best', '最佳画质', h.title);
              }
              ctx.status(`已加入 ${picked.length} 个下载`, 'ok');
            },
          },
        },
      );
    await Promise.all(
      sources.map((s, i) =>
        s.search!(ctx.intent.input, ctx.signal).then(
          (hits) => {
            answered++;
            lists[i] = hits.map((h) => ({ ...h, source: s }));
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
    if (!lists.some((l) => l.length)) return ctx.status(errors[0] ? explainError(errors[0]) : '没有找到。', 'error');
    render();
  },
};
