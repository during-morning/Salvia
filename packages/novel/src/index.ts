import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getText, template, type Context, type Handler, type PickItem, type ModuleApi, type PreviewData, type SalviaModule } from '@salvia/core';
import { downloadBook, type BookFormat } from './download.ts';
import type { Book } from './flow.ts';
import { bookInfo, content, search, toc } from './remote.ts';
import {
  allSources,
  applySubscription,
  importedSources,
  parseSources,
  removeImported,
  removeSubscription,
  saveImported,
  subscriptions,
  type BookSource,
  type Subscription,
} from './source.ts';

export { search, bookInfo, toc, content, type Book, type Chapter } from './flow.ts';
export { Analyzer } from './rule/analyze.ts';
export { allSources, parseSources, type BookSource } from './source.ts';
export { buildEpub, buildTxt } from './export/epub.ts';

const SEARCH_CONCURRENCY = 32; // different sites each, so this is not hammering one host
const SOURCE_TIMEOUT_MS = 15_000;

function norm(s: string): string {
  return s.replace(/[\s·・,，。.:：!！?？()（）[\]【】《》"'“”‘’—-]/g, '').toLowerCase();
}

export interface Group {
  key: string;
  name: string;
  author: string;
  books: Book[];
}

/**
 * Same book across sources → one group, keyed by title + author. A result without an author joins
 * the biggest same-titled group, and an author-less group is folded in once an author shows up.
 */
export function addToGroups(groups: Map<string, Group>, b: Book): void {
  const name = norm(b.name);
  const author = norm(b.author);
  const sameTitle = () => [...groups.values()].filter((g) => norm(g.name) === name).sort((x, y) => y.books.length - x.books.length);
  if (!author) {
    const target = sameTitle().find((g) => norm(g.author)) ?? groups.get(`${name}|`);
    const g = target ?? { key: `${name}|`, name: b.name, author: '', books: [] };
    g.books.push(b);
    groups.set(g.key, g);
    return;
  }
  const k = `${name}|${author}`;
  const g = groups.get(k) ?? { key: k, name: b.name, author: b.author, books: [] };
  g.books.push(b);
  groups.set(k, g);
  const orphan = groups.get(`${name}|`);
  if (orphan && orphan !== g) {
    g.books.push(...orphan.books);
    groups.delete(orphan.key);
  }
}

function relevance(g: Group, key: string): number {
  const n = norm(g.name);
  const k = norm(key);
  if (n === k || norm(g.author) === k) return 0;
  if (n.startsWith(k)) return 1;
  if (n.includes(k)) return 2;
  return 3;
}

/**
 * Worth showing at all. Many sources do full-text or fuzzy search and answer with books that only
 * share a character or two with the query; those are dropped.
 */
export function related(g: Pick<Group, 'name' | 'author'>, key: string): boolean {
  if (relevance(g as Group, key) < 3) return true;
  const k = [...new Set(norm(key))];
  if (!k.length) return true;
  const name = norm(g.name);
  return k.filter((c) => name.includes(c)).length / k.length >= 0.6;
}

const PREVIEW_CHAPTERS = 3;

/** Book details and the first chapters, from the first source in the group that answers. */
async function bookPreview(group: Group, signal: AbortSignal): Promise<PreviewData> {
  let lastError: unknown;
  for (const book of group.books.slice(0, 4)) {
    try {
      const s = withTimeout(signal, SOURCE_TIMEOUT_MS * 4);
      await bookInfo(book, s);
      const chapters = (await toc(book, s)).filter((c) => !c.isVolume && c.url);
      if (!chapters.length) continue;
      const first = chapters.slice(0, PREVIEW_CHAPTERS);
      const texts: { title: string; text: string }[] = [];
      for (const [i, c] of first.entries()) {
        texts.push({ title: c.title, text: await content(book, c, chapters[i + 1]?.url, s) });
      }
      return {
        title: book.name,
        subtitle: book.author,
        fields: [
          { label: '作者', value: book.author },
          { label: '分类', value: book.kind ?? '' },
          { label: '字数', value: book.wordCount ?? '' },
          { label: '章节', value: `${chapters.length} 章` },
          { label: '最新', value: book.lastChapter ?? chapters[chapters.length - 1]?.title ?? '' },
          { label: '书源', value: group.books.length > 1 ? `${book.source.bookSourceName} 等 ${group.books.length} 个` : book.source.bookSourceName },
        ].filter((f) => f.value),
        sections: [...(book.intro ? [{ title: '简介', text: book.intro.trim() }] : []), ...texts],
      };
    } catch (err) {
      if (signal.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error('这本书的书源都没有返回目录。');
}

/** Run `fn` over `items` with a concurrency limit. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function enqueueBook(ctx: Context, book: Book, format: BookFormat): void {
  const name = template('{name}', { name: book.author ? `${book.name} - ${book.author}` : book.name });
  const out = join(ctx.config.downloadDir, `${name}.${format}`);
  ctx.enqueue({
    kind: 'novel',
    title: `${book.name} · ${format.toUpperCase()}`,
    host: new URL(book.source.bookSourceUrl).host,
    run: (signal, report) => downloadBook(book, format, out, signal, report),
  });
  ctx.status(`已加入下载：${book.name}（${format.toUpperCase()}）`, 'ok');
}

async function showBook(ctx: Context, group: Group, index = 0): Promise<void> {
  const book = group.books[index]!;
  ctx.status(`读取 ${book.name}（${book.source.bookSourceName}）`);
  let chapters: number;
  try {
    await bookInfo(book, withTimeout(ctx.signal, SOURCE_TIMEOUT_MS * 2));
    chapters = (await toc(book, withTimeout(ctx.signal, SOURCE_TIMEOUT_MS * 4))).length;
  } catch (err) {
    if (ctx.signal.aborted) return;
    // This source is broken for this book; try the next one if there is one.
    if (index + 1 < group.books.length) return showBook(ctx, group, index + 1);
    throw err;
  }
  if (!chapters) {
    if (index + 1 < group.books.length) return showBook(ctx, group, index + 1);
    return ctx.status('这个书源返回的目录是空的。', 'error');
  }
  const head = [book.name, book.author, `${chapters} 章`, book.source.bookSourceName].filter(Boolean).join(' · ');
  ctx.status(head, 'idle');
  const items: PickItem[] = [
    { id: 'epub', title: '下载 EPUB', meta: book.lastChapter, pick: () => enqueueBook(ctx, book, 'epub') },
    { id: 'txt', title: '下载 TXT', pick: () => enqueueBook(ctx, book, 'txt') },
  ];
  if (book.intro) items.push({ id: 'intro', title: book.intro.replace(/\s+/g, ' ').slice(0, 120), disabled: true });
  if (group.books.length > 1) {
    items.push({
      id: 'sources',
      title: `换源（共 ${group.books.length} 个）…`,
      pick: () =>
        ctx.items(
          group.books.map((b, i) => ({
            id: `s:${i}`,
            title: b.source.bookSourceName,
            meta: b.lastChapter,
            pick: () => showBook(ctx, group, i),
          })),
        ),
    });
  }
  ctx.items(items);
}

async function searchAll(ctx: Context): Promise<void> {
  const key = ctx.intent.input;
  const all = allSources();
  if (!all.length) return ctx.status('没有可用的书源。用 @source add <链接或文件> 导入 Legado 书源。', 'error');
  // @novel:<书源> narrows to sources whose name or group contains it.
  const want = ctx.intent.platform?.toLowerCase();
  const sources = want
    ? all.filter((s) => s.bookSourceName.toLowerCase().includes(want) || (s.bookSourceGroup ?? '').toLowerCase().includes(want))
    : all;
  if (!sources.length) {
    return ctx.status(`没有名字含"${ctx.intent.platform}"的书源。可用：${all.map((s) => s.bookSourceName).slice(0, 8).join('、')}`, 'error');
  }
  ctx.status(`在 ${sources.length} 个书源中搜索"${key}"`);

  // Opening a book ends the search: later results must not replace the book page.
  const stop = new AbortController();
  const signal = AbortSignal.any([ctx.signal, stop.signal]);
  const groups = new Map<string, Group>();
  let shown = 0;
  let answered = 0;
  let failed = 0;
  const render = () => {
    const list = [...groups.values()]
      .filter((g) => related(g, key))
      .sort((a, b) => relevance(a, key) - relevance(b, key) || b.books.length - a.books.length);
    shown = list.length;
    ctx.items(
      list.map((g) => ({
        id: `b:${g.key}`,
        title: g.name,
        cells: [g.name, g.author, g.books[0]?.lastChapter ?? '', g.books.length > 1 ? `${g.books.length} 个书源` : (g.books[0]?.source.bookSourceName ?? '')],
        meta: [g.author, g.books[0]?.lastChapter, g.books.length > 1 ? `${g.books.length} 个书源` : g.books[0]?.source.bookSourceName]
          .filter(Boolean)
          .join(' · '),
        pick: () => {
          if (!stop.signal.aborted) {
            stop.abort();
            ctx.status(`找到 ${shown} 本 · 已停止搜索`, 'idle');
          }
          return showBook(ctx, g);
        },
        previewer: (signal: AbortSignal) => bookPreview(g, signal),
      })),
      {
        columns: [
          { title: '书名', flex: 2 },
          { title: '作者', flex: 1 },
          { title: '最新章节', flex: 2 },
          { title: '书源', width: 14 },
        ],
      },
    );
  };

  await pool(sources, SEARCH_CONCURRENCY, async (source: BookSource) => {
    if (signal.aborted) return;
    try {
      const books = await search(source, key, withTimeout(signal, SOURCE_TIMEOUT_MS));
      if (signal.aborted) return;
      for (const b of books) addToGroups(groups, b);
      answered++;
      if (books.length) render();
    } catch {
      failed++;
    }
    if (!signal.aborted) ctx.status(`在 ${sources.length} 个书源中搜索"${key}"（${answered + failed}/${sources.length}）`);
  });

  if (signal.aborted) return;
  if (!shown) return ctx.status(failed === sources.length ? '所有书源都没有响应。' : `没有找到"${key}"。`, 'error');
  ctx.status(`找到 ${shown} 本 · ${answered} 个书源有响应`, 'idle');
}

export const novelHandler: Handler = {
  id: 'novel',
  kinds: ['novel-search'],
  handle: searchAll,
};

async function loadSourceText(spec: string): Promise<string> {
  try {
    if (/^https?:\/\//i.test(spec)) return await getText(spec, { timeout: 30_000 });
    return await readFile(resolve(spec), 'utf8');
  } catch (err) {
    throw new Error(`读取书源失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

const isLink = (spec: string) => /^https?:\/\//i.test(spec);

/** Read each subscription again: new sources come in, ones it no longer lists go. */
async function updateSubscriptions(ctx: Context, subs: Subscription[]): Promise<void> {
  if (!subs.length) return ctx.status('还没有订阅。用 @source add <书源链接> 导入并订阅。', 'error');
  ctx.status(`更新 ${subs.length} 个订阅`);
  let count = 0;
  let removed = 0;
  const failed: string[] = [];
  for (const sub of subs) {
    try {
      const sources = parseSources(await loadSourceText(sub.url));
      if (!sources.length) throw new Error('没有书源');
      const r = applySubscription(sub.url, sources);
      count += r.count;
      removed += r.removed;
    } catch {
      failed.push(sub.url);
    }
    if (ctx.signal.aborted) return;
  }
  const done = subs.length - failed.length;
  ctx.status(
    [done ? `已更新 ${done} 个订阅，共 ${count} 个书源${removed ? `，移除 ${removed} 个已下架的` : ''}` : '', failed.length ? `${failed.length} 个订阅读取失败：${failed.join('、')}` : '']
      .filter(Boolean)
      .join('；'),
    failed.length && !done ? 'error' : 'ok',
  );
}

/** Source names for completion; reading the source files on every keystroke would be wasteful. */
let names: { at: number; list: { name: string; group?: string; imported: boolean }[] } | undefined;
function sourceNames() {
  if (!names || Date.now() - names.at > 5000) {
    const imported = new Set(importedSources().map((s) => s.bookSourceUrl));
    names = { at: Date.now(), list: allSources().map((s) => ({ name: s.bookSourceName, group: s.bookSourceGroup, imported: imported.has(s.bookSourceUrl) })) };
  }
  return names.list;
}

/** `@novel` (Legado book sources), `@novel:<书源>`, `@source`, `@check`. */
export const novelModule: SalviaModule = {
  id: 'novel',
  setup(api) {
    registerNovel(api);
  },
};

function registerNovel(api: ModuleApi): void {
  api.handler(novelHandler);
  // @novel:<书源名> searches one source (or a group).
  api.targets('novel', () => sourceNames().map((s) => ({ value: s.name, meta: s.group ? `书源 · ${s.group}` : '书源' })));

  api.command({
    name: 'source',
    usage: '@source [add <链接或文件> | update | rm <名称、网址或订阅链接>]（Legado 书源）',
    complete(args) {
      if (args.length === 1) {
        return [
          { value: 'add', meta: '导入 Legado 书源（链接会被订阅，可用 update 更新；也可以是本地 JSON 文件）' },
          { value: 'update', meta: `更新订阅的书源（${subscriptions().length} 个订阅）` },
          { value: 'rm', meta: '删除已导入的书源或订阅' },
        ];
      }
      if (args[0] === 'add' && args.length === 2) return [{ value: '', meta: '输入书源链接，或本地 JSON 文件路径' }];
      if ((args[0] === 'rm' || args[0] === 'remove') && args.length >= 2) {
        return [
          ...subscriptions().map((s) => ({ value: s.url, meta: `订阅 · ${s.sources.length} 个书源` })),
          ...sourceNames()
            .filter((s) => s.imported)
            .map((s) => ({ value: s.name, meta: s.group })),
        ];
      }
      return [];
    },
    async run([action, ...rest], ctx) {
      const arg = rest.join(' ').trim();
      if (action === 'add' && arg) {
        ctx.status('导入书源');
        const sources = parseSources(await loadSourceText(arg));
        if (!sources.length) return ctx.status('没有找到书源（需要 Legado 格式的 JSON）。', 'error');
        const trust = '书源包含可执行脚本，请只导入你信任的来源。';
        if (!isLink(arg)) {
          saveImported(sources);
          return ctx.status(`已导入 ${sources.length} 个书源。${trust}`, 'ok');
        }
        applySubscription(arg, sources);
        return ctx.status(`已导入 ${sources.length} 个书源，并订阅了这个链接（@source update 更新）。${trust}`, 'ok');
      }
      if (action === 'update') return updateSubscriptions(ctx, subscriptions());
      if ((action === 'rm' || action === 'remove') && arg) {
        const sub = removeSubscription(arg);
        if (sub !== undefined) return ctx.status(`已取消订阅，删除了它的 ${sub} 个书源。`, 'ok');
        const n = removeImported((s) => s.bookSourceName === arg || s.bookSourceUrl === arg || s.bookSourceGroup === arg);
        return ctx.status(n ? `已删除 ${n} 个书源。` : '没有匹配的已导入书源。', n ? 'ok' : 'error');
      }
      const all = allSources();
      const subs = subscriptions();
      ctx.status(`共 ${all.length} 个可用书源${subs.length ? ` · ${subs.length} 个订阅（点开更新）` : ''}`, 'idle');
      ctx.items([
        ...subs.map((s) => ({
          id: `sub:${s.url}`,
          title: `订阅 · ${s.url}`,
          meta: `${s.sources.length} 个书源 · ${new Date(s.updated).toLocaleDateString()} 更新`,
          pick: () => updateSubscriptions(ctx, [s]),
        })),
        ...all.map((s) => ({ id: `src:${s.bookSourceUrl}`, title: s.bookSourceName, meta: s.bookSourceGroup ?? s.bookSourceUrl })),
      ]);
    },
  });

  api.command({
    name: 'check',
    usage: '@check [关键词]（检查书源是否可用）',
    complete: (args) => (args.length === 1 ? [{ value: '', meta: `可选：用这个关键词搜索检查；留空用各书源自带的检查词（共 ${sourceNames().length} 个书源）` }] : []),
    async run(args, ctx) {
      const sources = allSources();
      const items: PickItem[] = [];
      let ok = 0;
      ctx.status(`检查 ${sources.length} 个书源`);
      await pool(sources, SEARCH_CONCURRENCY, async (s) => {
        const key = args.join(' ') || s.ruleSearch?.checkKeyWord || '我的';
        const t0 = Date.now();
        let meta: string;
        let good = false;
        try {
          const books = await search(s, key, withTimeout(ctx.signal, SOURCE_TIMEOUT_MS));
          good = books.length > 0;
          meta = good ? `✓ ${books.length} 条 · ${Date.now() - t0} ms` : `✗ 没有结果（${key}）`;
        } catch (err) {
          meta = `✗ ${err instanceof Error ? err.message : String(err)}`.slice(0, 80);
        }
        if (good) ok++;
        items.push({ id: `chk:${s.bookSourceUrl}`, title: s.bookSourceName, meta, disabled: !good });
        ctx.items([...items]);
      });
      ctx.status(`${ok}/${sources.length} 个书源可用`, ok ? 'ok' : 'error');
    },
  });
}
export { runInternalFetch } from './rule/js.ts';
export { startNovelWorker } from './worker.ts';
