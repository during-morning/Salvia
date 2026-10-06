import type { Context, Handler, ListOptions, PickItem, PreviewData } from '@salvia/core';
import { bangumiSearch, bangumiSubject, infoValue, type Subject } from './bangumi.ts';
import { animeSource, animeSources, matchCatalog, type AnimeOffers, type AnimeSource, type AnimeTitle, type CatalogEntry } from './sources.ts';

const titleName = (t: AnimeTitle) => t.names.find(Boolean) ?? '';

/** Which sources can have a title: those whose catalogue matched it, and every source without a catalogue. */
function sourcesFor(t: AnimeTitle): AnimeSource[] {
  return animeSources().filter((s) => !s.catalog || t.entries.some((e) => e.source === s.id));
}

async function animePreview(t: AnimeTitle, signal: AbortSignal): Promise<PreviewData> {
  const full = t.subject ? await bangumiSubject(t.subject.id, signal).catch(() => t.subject) : undefined;
  const entry = t.entries[0];
  const info = (key: string) => infoValue(full?.infobox?.find((i) => i.key === key)?.value);
  return {
    title: full?.name_cn || full?.name || entry?.title || titleName(t),
    subtitle: full?.name_cn && full.name !== full.name_cn ? full.name : entry?.original,
    fields: [
      { label: '放送', value: full?.date ?? entry?.year ?? '' },
      { label: '话数', value: String(full?.total_episodes || full?.eps || entry?.episodes || '') },
      { label: '评分', value: full?.rating?.score ? `${full.rating.score}（Bangumi，${full.rating.total ?? 0} 人）` : entry?.score ? `${entry.score}` : '' },
      { label: '排名', value: full?.rating?.rank ? `#${full.rating.rank}` : '' },
      { label: '导演', value: info('导演') },
      { label: '动画制作', value: info('动画制作') },
      { label: '原作', value: info('原作') },
      { label: '标签', value: (full?.tags ?? []).slice(0, 8).map((x) => x.name).join('、') },
      { label: '片源', value: sourcesFor(t).map((s) => s.name).join(' + ') },
    ].filter((f) => f.value),
    sections: [{ title: '简介', text: full?.summary?.trim() || '（没有简介）' }],
  };
}

/** Every source's offers for a title, official ones first, as one list. */
async function showOffers(ctx: Context, t: AnimeTitle, only?: AnimeSource): Promise<void> {
  const name = titleName(t);
  // Picking this title already counted as a pick: only a later one (something else opened) wins.
  const picks = ctx.picks;
  ctx.status(`搜索 ${name} 的片源`);
  const sources = only ? [only] : sourcesFor(t).sort((a, b) => Number(!!b.official) - Number(!!a.official));
  const results = await Promise.all(
    sources.map((s) =>
      s.offers(t, ctx).then(
        (o) => ({ s, o }),
        () => ({ s, o: undefined as AnimeOffers | undefined, failed: true }),
      ),
    ),
  );
  if (ctx.signal.aborted || ctx.picks !== picks) return;
  const got = results.filter((r): r is { s: AnimeSource; o: AnimeOffers } => !!r.o?.items.length);
  const failed = results.filter((r) => 'failed' in r).map((r) => r.s.name);
  if (!got.length) return ctx.status(`没有找到 ${name} 的片源${failed.length ? `（${failed.join('、')} 暂时无法访问）` : ''}。`, 'error');
  // Ids are prefixed with the source, so rows (and checked rows) of different sources never collide.
  const items: PickItem[] = got.flatMap(({ s, o }) => o.items.map((i) => ({ ...i, id: `${s.id}:${i.id}` })));
  const table = got.find((r) => r.o.columns);
  const opts: ListOptions = { columns: table?.o.columns };
  const batches = got.filter((r) => r.o.batch);
  if (batches.length) {
    opts.batch = {
      label: batches[0]!.o.batch!.label,
      async run(ids) {
        for (const { s, o } of batches) {
          const mine = ids.filter((id) => id.startsWith(`${s.id}:`)).map((id) => id.slice(s.id.length + 1));
          if (mine.length) await o.batch!.run(mine);
        }
      },
    };
  }
  ctx.status([name, ...got.map((r) => r.o.summary), failed.length ? `${failed.join('、')} 无法访问` : '', ...got.map((r) => r.o.note)].filter(Boolean).join(' · '), 'idle');
  ctx.items(items, opts);
}

const COLUMNS = [
  { title: '名称', flex: 3 },
  { title: '原名', flex: 2 },
  { title: '放送', width: 8 },
  { title: '话数', width: 5, align: 'right' as const },
  { title: '评分', width: 5, align: 'right' as const },
  { title: '片源', width: 10 },
];

function titleRow(ctx: Context, t: AnimeTitle, id: string): PickItem {
  const s = t.subject;
  const e = t.entries[0];
  const name = titleName(t);
  const year = s?.date?.slice(0, 7) ?? e?.year ?? '';
  const eps = String(s?.total_episodes || s?.eps || e?.episodes || '');
  const score = s?.rating?.score ? String(s.rating.score) : e?.score ? String(e.score) : '';
  const where = sourcesFor(t).map((x) => x.name);
  return {
    id,
    title: name,
    meta: [year, eps ? `${eps} 话` : '', where.join(' + ')].filter(Boolean).join(' · '),
    cells: [name, s?.name && s.name !== name ? s.name : (e?.original ?? ''), year, eps, score, where.join(' + ')],
    pick: () => showOffers(ctx, t),
    previewer: (signal: AbortSignal) => animePreview(t, signal),
  };
}

/**
 * `@anime <番剧名>`: Bangumi's titles (plus titles only a source's catalogue has); a title opens
 * its offers from every source. `@anime:<source> <关键词>` asks one source.
 */
export const animeHandler: Handler = {
  id: 'anime',
  kinds: ['anime-search'],
  async handle(ctx) {
    const q = ctx.intent.input;
    const only = ctx.intent.platform ? animeSource(ctx.intent.platform) : undefined;
    if (ctx.intent.platform && !only) {
      return ctx.status(`没有片源"${ctx.intent.platform}"。可用：${animeSources().map((s) => s.id).join('、')}`, 'error');
    }
    // A source without a catalogue (an index): search it directly.
    if (only && !only.catalog) return showOffers(ctx, { names: [q], entries: [] }, only);

    const catalogs = only ? [only] : animeSources().filter((s) => s.catalog);
    ctx.status(`在${only ? only.name : ['Bangumi', ...catalogs.map((s) => s.name)].join('、')}搜索 ${q}`);
    let bangumiDown = false;
    const [subjects, entries] = await Promise.all([
      only
        ? ([] as Subject[])
        : bangumiSearch(q, ctx.signal).catch(() => {
            bangumiDown = true;
            return [] as Subject[];
          }),
      Promise.all(catalogs.map((s) => s.catalog!(q, ctx.signal).catch(() => [] as CatalogEntry[]))).then((l) => l.flat()),
    ]);
    if (ctx.signal.aborted) return;
    const used = new Set<CatalogEntry>();
    const titles: AnimeTitle[] = subjects.map((s) => {
      const matched = matchCatalog(s, entries);
      matched.forEach((e) => used.add(e));
      return { names: [s.name_cn ?? '', s.name], subject: s, entries: matched };
    });
    for (const e of entries) if (!used.has(e)) titles.push({ names: [e.title, e.original ?? ''], entries: [e] });
    if (!titles.length) {
      return ctx.status(
        only && !entries.length
          ? `${only.name}没有返回结果（可能当前网络不在它的服务地区）。`
          : bangumiDown
            ? `Bangumi 暂时无法访问，稍后再试；也可以用 @anime:bt ${q} 直接搜 BT 资源。`
            : '没有找到。',
        'error',
      );
    }
    const official = titles.filter((t) => t.entries.some((e) => animeSource(e.source)?.official)).length;
    ctx.status(`${titles.length} 部${official ? ` · 正版 ${official} 部` : ''} · 点开查看片源`, 'idle');
    ctx.items(
      titles.map((t, i) => titleRow(ctx, t, t.subject ? `bgm:${t.subject.id}` : `${t.entries[0]!.source}:${t.entries[0]!.id}:${i}`)),
      { columns: COLUMNS },
    );
  },
};
