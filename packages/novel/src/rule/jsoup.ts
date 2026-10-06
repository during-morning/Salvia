import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { Node as DomNode, type AnyNode } from 'domhandler';
import { CHEERIO_OPTIONS } from './pseudos.ts';

/**
 * The slice of Jsoup's API that book-source JS uses through `org.jsoup.Jsoup.parse(html)`,
 * implemented on cheerio: Document/Element/Elements with select, text, attr, html, eachText, remove…
 * Elements is iterable and has `length`, so `Array.from(els)` and `for…of` work as in Rhino.
 */

export class JElement {
  constructor(
    readonly $: CheerioAPI,
    readonly node: AnyNode,
    private readonly baseUri = '',
  ) {}

  private get c(): Cheerio<AnyNode> {
    return this.$(this.node);
  }

  select(css: string): JElements {
    return new JElements(this.$, this.c.find(css).toArray(), this.baseUri);
  }
  selectFirst(css: string): JElement | null {
    return this.select(css).first();
  }
  getElementsByTag(tag: string): JElements {
    return this.select(tag);
  }
  getElementsByClass(cls: string): JElements {
    return this.select(`.${cls}`);
  }
  getElementById(id: string): JElement | null {
    return this.select(`[id="${id}"]`).first();
  }
  text(): string {
    return this.c.text().replace(/\s+/g, ' ').trim();
  }
  wholeText(): string {
    return this.c.text();
  }
  ownText(): string {
    return this.c
      .contents()
      .toArray()
      .filter((n) => n.type === 'text')
      .map((n) => (n as unknown as { data: string }).data)
      .join('')
      .trim();
  }
  attr(name: string, value?: string): string | JElement {
    if (value !== undefined) {
      this.c.attr(name, value);
      return this;
    }
    if (name.startsWith('abs:')) return this.absUrl(name.slice(4));
    return this.c.attr(name) ?? '';
  }
  hasAttr(name: string): boolean {
    return this.c.attr(name) !== undefined;
  }
  absUrl(name: string): string {
    const v = this.c.attr(name) ?? '';
    try {
      return v ? new URL(v, this.baseUri || undefined).href : '';
    } catch {
      return v;
    }
  }
  html(): string {
    return this.c.html() ?? '';
  }
  outerHtml(): string {
    return this.$.html(this.node) ?? '';
  }
  tagName(): string {
    return (this.node as { tagName?: string }).tagName ?? '';
  }
  className(): string {
    return this.c.attr('class') ?? '';
  }
  hasClass(cls: string): boolean {
    return this.c.hasClass(cls);
  }
  children(): JElements {
    return new JElements(this.$, this.c.children().toArray(), this.baseUri);
  }
  child(i: number): JElement | null {
    return this.children().get(i);
  }
  parent(): JElement | null {
    const p = this.c.parent().toArray()[0];
    return p ? new JElement(this.$, p, this.baseUri) : null;
  }
  nextElementSibling(): JElement | null {
    const n = this.c.next().toArray()[0];
    return n ? new JElement(this.$, n, this.baseUri) : null;
  }
  previousElementSibling(): JElement | null {
    const n = this.c.prev().toArray()[0];
    return n ? new JElement(this.$, n, this.baseUri) : null;
  }
  remove(): void {
    this.c.remove();
  }
  title(): string {
    return this.$('title').first().text().trim();
  }
  body(): JElement | null {
    const b = this.$('body').toArray()[0];
    return b ? new JElement(this.$, b, this.baseUri) : null;
  }
  toString(): string {
    return this.outerHtml();
  }
}

export class JElements {
  private readonly items: JElement[];

  constructor($: CheerioAPI, nodes: AnyNode[], baseUri = '') {
    this.items = nodes.map((n) => new JElement($, n, baseUri));
  }

  get length(): number {
    return this.items.length;
  }
  [Symbol.iterator](): Iterator<JElement> {
    return this.items[Symbol.iterator]();
  }
  size(): number {
    return this.items.length;
  }
  isEmpty(): boolean {
    return this.items.length === 0;
  }
  get(i: number): JElement | null {
    return this.items[i] ?? null;
  }
  first(): JElement | null {
    return this.items[0] ?? null;
  }
  last(): JElement | null {
    return this.items[this.items.length - 1] ?? null;
  }
  select(css: string): JElements {
    const out = this.items.flatMap((e) => e.select(css).items);
    const r = new JElements(this.items[0]?.$ ?? load('', CHEERIO_OPTIONS), []);
    r.items.push(...out);
    return r;
  }
  text(): string {
    return this.items.map((e) => e.text()).join(' ');
  }
  eachText(): string[] {
    return this.items.map((e) => e.text()).filter(Boolean);
  }
  attr(name: string): string {
    for (const e of this.items) if (e.hasAttr(name.replace(/^abs:/, ''))) return String(e.attr(name));
    return '';
  }
  eachAttr(name: string): string[] {
    return this.items.filter((e) => e.hasAttr(name.replace(/^abs:/, ''))).map((e) => String(e.attr(name)));
  }
  html(): string {
    return this.items.map((e) => e.html()).join('\n');
  }
  outerHtml(): string {
    return this.items.map((e) => e.outerHtml()).join('\n');
  }
  remove(): JElements {
    for (const e of this.items) e.remove();
    return this;
  }
  toArray(): JElement[] {
    return [...this.items];
  }
  forEach(fn: (e: JElement, i: number) => void): void {
    this.items.forEach(fn);
  }
  map<T>(fn: (e: JElement, i: number) => T): T[] {
    return this.items.map(fn);
  }
  toString(): string {
    return this.outerHtml();
  }
}

const $w = load('', CHEERIO_OPTIONS, false);

/** Rule results going into JS: nodes become Jsoup-style Element/Elements (what Legado scripts get). */
export function toJs(v: unknown): unknown {
  if (v instanceof DomNode) return new JElement($w, v as AnyNode);
  if (Array.isArray(v) && v.length && v.every((x) => x instanceof DomNode)) return new JElements($w, v as AnyNode[]);
  return v;
}

/** Values coming back from JS: Jsoup-style objects become nodes again (also inside plain arrays). */
export function fromJs(v: unknown): unknown {
  if (v instanceof JElement) return v.node;
  if (v instanceof JElements) return v.toArray().map((e) => e.node);
  if (Array.isArray(v)) return v.map((x) => (x instanceof JElement ? x.node : x));
  return v;
}

export const Jsoup = {
  parse(html: unknown, baseUri = ''): JElement {
    const $ = load(String(html ?? ''), CHEERIO_OPTIONS);
    return new JElement($, $.root().toArray()[0]!, baseUri);
  },
  clean(html: unknown): string {
    return load(String(html ?? ''), CHEERIO_OPTIONS).text();
  },
};
