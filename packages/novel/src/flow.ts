import { FatalError, HttpError } from '@salvia/core';
import { cleanContent, htmlToText } from './clean.ts';
import { Analyzer, stringify } from './rule/analyze.ts';
import { MOBILE_UA, hasUa, setSourceUa, sourceObject } from './rule/js.ts';
import { sourceHeaders, type BookSource } from './source.ts';
import { absolute, fetchRule, isNavLink, type Fetched } from './url.ts';

export interface Book {
  name: string;
  author: string;
  bookUrl: string;
  tocUrl?: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  wordCount?: string;
  lastChapter?: string;
  source: BookSource;
  /** @put/@get variables collected for this book. */
  vars: Map<string, string>;
  /** Book page already fetched during search/info, reused for the toc when tocUrl = bookUrl. */
  page?: Fetched;
}

export interface Chapter {
  title: string;
  url: string;
  isVolume?: boolean;
}

const MAX_TOC_PAGES = 200;
const MAX_CONTENT_PAGES = 30;

/** Legado list rules: a leading "-" reverses, "+" is a no-op marker. */
function listRule(rule: string): { rule: string; reverse: boolean } {
  if (rule.startsWith('-')) return { rule: rule.slice(1), reverse: true };
  if (rule.startsWith('+')) return { rule: rule.slice(1), reverse: false };
  return { rule, reverse: false };
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** "最新章节：第十章" → "第十章": sources often keep the page's label. */
export function unlabel(s: string): string {
  return cleanText(s).replace(/^(最新章节|最新|更新|分类|类别|类型|字数|状态|标签)\s*[:：]\s*/, '');
}

/**
 * Author as a name only. Sources often grab the whole info line ("天蚕土豆 分类:武侠 更新:…",
 * "作者：某某 | 完结"), which would stop the same book from merging across sources.
 */
export function cleanAuthor(s: string): string {
  const text = cleanText(s);
  // "玄幻奇幻 | 作者：九支书竹 · 完结": the labelled name wins over whatever comes first.
  const labelled = text.match(/作\s*者\s*[:：]\s*(.+)$/)?.[1];
  return (labelled ?? text)
    .replace(/^(作\s*者|著|作家)\s*[:：]?\s*/, '')
    .split(/\s*[|｜/·•]\s*|\s+(?=(分类|类别|类型|来源|更新|状态|字数|最新|连载|完结|标签)\s*[:：]?)/)[0]!
    .replace(/\s*(著|作品)$/, '')
    .trim();
}

/** What rule JS sees: `book`, and Legado's `source` object (which also carries the source's jsLib). */
function bindings(source: BookSource, vars: Map<string, string>, book?: Partial<Book>) {
  return {
    book: {
      ...(book ? { name: book.name, author: book.author, bookUrl: book.bookUrl, tocUrl: book.tocUrl, origin: source.bookSourceUrl } : {}),
      ...variableMethods(vars, 'book'),
    },
    source: sourceObject(source, vars),
  };
}

/** Legado's book.putVariable(k, v) / getVariable(k) (and the no-key form for the whole value). */
export function variableMethods(vars: Map<string, string>, scope: string) {
  return {
    putVariable: (k: string, v?: unknown) => {
      if (v === undefined) vars.set(`${scope}:`, String(k ?? ''));
      else vars.set(`${scope}:${k}`, String(v ?? ''));
      return true;
    },
    getVariable: (k?: string) => vars.get(`${scope}:${k ?? ''}`) ?? '',
  };
}

function matchesBookUrl(source: BookSource, url: string): boolean {
  if (!source.bookUrlPattern) return false;
  try {
    return new RegExp(source.bookUrlPattern).test(url);
  } catch {
    return false;
  }
}

/**
 * Search one source. Sources that don't set a User-Agent are tried with Legado's desktop UA, then
 * with a phone UA if that finds nothing or is refused; the one that works sticks for this source.
 */
export async function search(source: BookSource, key: string, signal?: AbortSignal, page = 1): Promise<Book[]> {
  if (hasUa(sourceHeaders(source))) return searchOnce(source, key, signal, page);
  let first: Book[] | undefined;
  let error: unknown;
  try {
    first = await searchOnce(source, key, signal, page);
    if (first.length) return first;
  } catch (err) {
    // Only an HTTP refusal is worth a second try; timeouts and network errors won't change.
    if (!(err instanceof HttpError) || signal?.aborted) throw err;
    error = err;
  }
  setSourceUa(source.bookSourceUrl, MOBILE_UA);
  try {
    const second = await searchOnce(source, key, signal, page);
    if (second.length) return second;
  } catch {
    // fall through to the first attempt's outcome
  }
  setSourceUa(source.bookSourceUrl, undefined);
  if (error) throw error;
  return first ?? [];
}

async function searchOnce(source: BookSource, key: string, signal?: AbortSignal, page = 1): Promise<Book[]> {
  if (!source.searchUrl) return [];
  const vars = new Map<string, string>();
  const res = await fetchRule(source, source.searchUrl, { key, page, vars }, signal);
  const r = source.ruleSearch ?? {};
  // Legado exposes the search word and page to rule JS as well, not only to the URL.
  const root = new Analyzer(res.body, res.url, vars, { ...bindings(source, vars), key, page });
  const { rule, reverse } = listRule(r.bookList ?? '');
  let items = rule ? root.getElements(rule) : [];
  if (reverse) items = items.reverse();

  // Some sites jump straight to the book page when there is a single hit.
  if (!items.length && matchesBookUrl(source, res.url)) {
    const book: Book = { name: '', author: '', bookUrl: res.url, source, vars, page: res };
    await fillInfo(book, res);
    return book.name ? [book] : [];
  }

  const books: Book[] = [];
  for (const el of items) {
    const a = root.child(el);
    a.vars = new Map(vars);
    const name = cleanText(a.getString(r.name ?? ''));
    if (!name) continue;
    const bookUrl = absolute(a.getString(r.bookUrl ?? ''), res.url) || res.url;
    books.push({
      name,
      author: cleanAuthor(a.getString(r.author ?? '')),
      bookUrl,
      coverUrl: absolute(a.getString(r.coverUrl ?? ''), res.url) || undefined,
      intro: a.getString(r.intro ?? '') || undefined,
      kind: unlabel(a.getStringList(r.kind ?? '').join(',')) || undefined,
      wordCount: unlabel(a.getString(r.wordCount ?? '')) || undefined,
      lastChapter: unlabel(a.getString(r.lastChapter ?? '')) || undefined,
      source,
      vars: a.vars,
    });
  }
  return books;
}

async function fillInfo(book: Book, page: Fetched): Promise<void> {
  const r = book.source.ruleBookInfo ?? {};
  let a = new Analyzer(page.body, page.url, book.vars, bindings(book.source, book.vars, book));
  if (r.init) {
    const init = a.getElement(r.init);
    if (init !== undefined) a = a.child(init);
  }
  const pick = (rule?: string) => (rule ? a.getString(rule) : '');
  book.name = cleanText(pick(r.name)) || book.name;
  book.author = cleanAuthor(pick(r.author)) || book.author;
  book.intro = pick(r.intro) || book.intro;
  book.kind = unlabel(r.kind ? a.getStringList(r.kind).join(',') : '') || book.kind;
  book.wordCount = unlabel(pick(r.wordCount)) || book.wordCount;
  book.lastChapter = unlabel(pick(r.lastChapter)) || book.lastChapter;
  book.coverUrl = absolute(pick(r.coverUrl), page.url) || book.coverUrl;
  book.tocUrl = absolute(pick(r.tocUrl), page.url) || page.url;
}

/** Fetch the book page and fill details. Cheap no-op when the source has no book-info rules. */
export async function bookInfo(book: Book, signal?: AbortSignal): Promise<Book> {
  const r = book.source.ruleBookInfo;
  const hasRules = r && Object.values(r).some((v) => typeof v === 'string' && v.trim());
  if (!hasRules) {
    book.tocUrl ??= book.bookUrl;
    return book;
  }
  const page = book.page && book.page.url === book.bookUrl ? book.page : await fetchRule(book.source, book.bookUrl, { vars: book.vars, book: bindings(book.source, book.vars, book).book }, signal);
  book.page = page;
  await fillInfo(book, page);
  return book;
}

/**
 * Chapter list. Follows nextTocUrl (one or many URLs) breadth-first, then drops duplicate URLs
 * keeping their last position — sites often show a "latest chapters" block above the full list.
 */
export async function toc(book: Book, signal?: AbortSignal): Promise<Chapter[]> {
  const r = book.source.ruleToc ?? {};
  if (!r.chapterList) throw new FatalError('书源没有目录规则。');
  const start = book.tocUrl ?? book.bookUrl;
  const queue: string[] = [start];
  const seen = new Set<string>();
  const chapters: Chapter[] = [];
  const { rule, reverse } = listRule(r.chapterList);

  while (queue.length && seen.size < MAX_TOC_PAGES) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const page = book.page && book.page.url === url ? book.page : await fetchRule(book.source, url, { vars: book.vars, book: bindings(book.source, book.vars, book).book }, signal);
    const root = new Analyzer(page.body, page.url, book.vars, bindings(book.source, book.vars, book));
    let items = root.getElements(rule);
    if (reverse) items = items.reverse();
    for (const el of items) {
      const a = root.child(el);
      const title = cleanText(a.getString(r.chapterName ?? ''));
      if (!title) continue;
      const href = r.chapterUrl ? a.getString(r.chapterUrl) : '';
      const isVolume = r.isVolume ? /^(true|1|yes)$/i.test(a.getString(r.isVolume).trim()) : false;
      const url = absolute(href, page.url);
      if (url && !isVolume && isNavLink(url, page.url)) continue; // "#footer", "javascript:…"
      chapters.push({ title, url: url || (isVolume ? '' : page.url), isVolume });
    }
    if (r.nextTocUrl) {
      for (const next of root.getStringList(r.nextTocUrl)) {
        const abs = absolute(next.trim(), page.url);
        if (abs && !seen.has(abs) && abs !== page.url) queue.push(abs);
      }
    }
  }

  const lastIndex = new Map<string, number>();
  chapters.forEach((c, i) => c.url && lastIndex.set(c.url, i));
  return chapters.filter((c, i) => c.isVolume || !c.url || lastIndex.get(c.url) === i);
}

/** Chapter text, following nextContentUrl pages until the next chapter starts. */
export async function content(book: Book, chapter: Chapter, nextChapterUrl?: string, signal?: AbortSignal): Promise<string> {
  const r = book.source.ruleContent ?? {};
  if (!r.content) throw new FatalError('书源没有正文规则。');
  if (chapter.isVolume || !chapter.url) return '';
  const parts: string[] = [];
  const seen = new Set<string>();
  let url: string | undefined = chapter.url;
  while (url && !seen.has(url) && seen.size < MAX_CONTENT_PAGES) {
    seen.add(url);
    const page = await fetchRule(book.source, url, { vars: book.vars, book: bindings(book.source, book.vars, book).book }, signal);
    const a = new Analyzer(page.body, page.url, book.vars, { ...bindings(book.source, book.vars, book), chapter: { title: chapter.title, url: chapter.url, ...variableMethods(book.vars, `chapter:${chapter.url}`) } });
    parts.push(htmlToText(stringify(a.getString(r.content))));
    url = undefined;
    if (r.nextContentUrl) {
      const next = a.getStringList(r.nextContentUrl).map((u) => absolute(u.trim(), page.url)).find(Boolean);
      if (next && next !== nextChapterUrl && next !== book.tocUrl && next !== book.bookUrl) url = next;
    }
  }
  return cleanContent(parts.join('\n'), chapter.title, r.replaceRegex);
}
