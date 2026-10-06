import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { Node as DomNode, type AnyNode } from 'domhandler';
import { JSONPath } from 'jsonpath-plus';
import { parseHTML } from 'linkedom';
import xpath from 'xpath';
import vm from 'node:vm';
import { evalJs, parseLooseJson, type JsBindings, type JsHost } from './js.ts';
import { fromJs, toJs } from './jsoup.ts';
import { CHEERIO_OPTIONS } from './pseudos.ts';
import { applyReplace, splitCombinators, splitJs, splitReplace, splitTop, type Combinator } from './split.ts';

/**
 * What a rule's first JS piece sees as `result`: the content itself, as Legado passes it (an element
 * stays an element, JSON stays JSON); only regex matches and XPath nodes become strings.
 */
function jsInput(content: unknown): unknown {
  return content instanceof RegexMatch || isLinkedom(content) ? stringify(content) : content;
}

/** Does this text parse as a script? (Used to tell JS from JS followed by `##regex`.) */
function compiles(code: string): boolean {
  try {
    new vm.Script(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Legado-compatible rule analyzer (AnalyzeRule.kt in Legado, reimplemented).
 *
 * Content can be an HTML string, a cheerio/domhandler node, a JSON value, a regex match
 * (from `:regex` list rules) or a linkedom node (from XPath). Each mode converts as needed.
 */

/** Groups of one `:regex` list match; fields read them as $1, $2 … */
class RegexMatch {
  constructor(readonly groups: string[]) {}
}

type Mode = 'jsoup' | 'css' | 'json' | 'xpath' | 'regex';

const $0: CheerioAPI = load('', CHEERIO_OPTIONS, false);

function isDom(x: unknown): x is AnyNode {
  return x instanceof DomNode;
}

/** linkedom nodes: plain objects with nodeType and ownerDocument. */
function isLinkedom(x: unknown): x is { nodeType: number; outerHTML?: string; textContent?: string; value?: string; data?: string } {
  return !!x && typeof x === 'object' && !isDom(x) && typeof (x as { nodeType?: unknown }).nodeType === 'number';
}

function looksJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

export function stringify(x: unknown): string {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (isDom(x)) return $0.html(x as AnyNode) ?? '';
  if (x instanceof RegexMatch) return x.groups[0] ?? '';
  if (isLinkedom(x)) return x.outerHTML ?? x.value ?? x.data ?? x.textContent ?? '';
  return JSON.stringify(x);
}

function toJson(x: unknown): unknown {
  if (typeof x === 'string') {
    try {
      return parseLooseJson(x);
    } catch {
      return x;
    }
  }
  if (isDom(x)) return toJson($0(x as AnyNode).text());
  return x;
}

function toCheerio(x: unknown): Cheerio<AnyNode> {
  if (isDom(x)) return $0(x as AnyNode);
  const doc = load(typeof x === 'string' ? x : stringify(x), CHEERIO_OPTIONS);
  return doc.root();
}

function toLinkedomNode(x: unknown): unknown {
  // Documents are used as-is. An element is re-parsed on its own, so `//x` searches inside it
  // (as JsoupXpath does in Legado) rather than the whole page it came from.
  if (isLinkedom(x) && x.nodeType === 9) return x;
  const html = stringify(x);
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`);
  return document;
}

function detectMode(raw: string, content: unknown): { mode: Mode; rule: string } {
  const rule = raw.trim();
  const lower = rule.slice(0, 7).toLowerCase();
  if (lower.startsWith('@css:')) return { mode: 'css', rule: rule.slice(5) };
  if (lower.startsWith('@json:')) return { mode: 'json', rule: rule.slice(6) };
  if (lower.startsWith('@xpath:')) return { mode: 'xpath', rule: rule.slice(7) };
  if (rule.startsWith('@@')) return { mode: 'jsoup', rule: rule.slice(2) };
  if (rule.startsWith('$.') || rule.startsWith('$[')) return { mode: 'json', rule };
  if (rule.startsWith('/')) return { mode: 'xpath', rule };
  if (rule.startsWith(':')) return { mode: 'regex', rule: rule.slice(1) };
  const json = (typeof content === 'string' && looksJson(content)) || (!!content && typeof content === 'object' && !isDom(content) && !isLinkedom(content) && !(content instanceof RegexMatch));
  if (json) return { mode: 'json', rule: rule.startsWith('$') ? rule : `$.${rule}` };
  return { mode: 'jsoup', rule };
}

// ---------- Legado default (JSoup) syntax ----------

interface Segment {
  kind: 'class' | 'id' | 'tag' | 'text' | 'children' | 'css';
  name: string;
  pick?: number[] | { start?: number; end?: number; step: number }[];
  exclude?: boolean;
}

function parseIndexList(spec: string): { list: (number | { start?: number; end?: number; step: number })[] } {
  const list: (number | { start?: number; end?: number; step: number })[] = [];
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes(':')) {
      const [a, b, c] = p.split(':');
      list.push({ start: a ? Number(a) : undefined, end: b ? Number(b) : undefined, step: c ? Number(c) : 1 });
    } else list.push(Number(p));
  }
  return { list };
}

function parseSegment(raw: string): Segment {
  let s = raw.trim();
  let pick: Segment['pick'];
  let exclude = false;
  // New syntax: trailing [1,2] / [1:3] / [!0]
  const bracket = s.match(/\[(!?)([-\d:,\s]+)\]$/);
  if (bracket) {
    exclude = bracket[1] === '!';
    pick = parseIndexList(bracket[2]!).list as Segment['pick'];
    s = s.slice(0, bracket.index);
  }
  // Old syntax, on any segment: `tag.a.0`, `dd.2:3` (elements 2 and 3), `.book_other.-1`,
  // `li!0:1:2` (all but 0, 1, 2). A CSS class can't start with a digit, so `.N` at the end is an index.
  if (!pick) {
    const ex = s.match(/^(.*?)\.?!(-?\d+(?::-?\d+)*)$/); // `li!0:1` and `li.!0:1`
    const idx = s.match(/^(.+?)\.(-?\d+(?::-?\d+)*)$/);
    if (ex && ex[1]) {
      s = ex[1];
      exclude = true;
      pick = ex[2]!.split(':').map(Number);
    } else if (idx) {
      s = idx[1]!;
      pick = idx[2]!.split(':').map(Number);
    }
  }
  const typed = s.match(/^(class|id|tag|text)\.(.+)$/);
  if (typed) return { kind: typed[1] as Segment['kind'], name: typed[2]!, pick, exclude };
  if (s === 'children') return { kind: 'children', name: '', pick, exclude };
  return { kind: 'css', name: s, pick, exclude };
}

function applyIndex<T>(items: T[], seg: Segment): T[] {
  if (!seg.pick?.length) return items;
  const n = items.length;
  const norm = (i: number) => (i < 0 ? n + i : i);
  const chosen = new Set<number>();
  for (const p of seg.pick as (number | { start?: number; end?: number; step: number })[]) {
    if (typeof p === 'number') chosen.add(norm(p));
    else {
      const start = p.start === undefined ? 0 : norm(p.start);
      const end = p.end === undefined ? n - 1 : norm(p.end);
      const step = Math.max(1, Math.abs(p.step));
      if (start <= end) for (let i = start; i <= end; i += step) chosen.add(i);
      else for (let i = start; i >= end; i -= step) chosen.add(i);
    }
  }
  if (seg.exclude) return items.filter((_, i) => !chosen.has(i));
  return [...chosen].filter((i) => i >= 0 && i < n).map((i) => items[i]!);
}

function selectSegment(nodes: AnyNode[], seg: Segment): AnyNode[] {
  try {
    return selectSegmentUnchecked(nodes, seg);
  } catch (err) {
    // Name the fragment: "Empty sub-selector" alone says nothing about which rule broke.
    throw new Error(`${(err as Error).message}（规则片段 ${seg.kind}:${seg.name}）`);
  }
}

function selectSegmentUnchecked(nodes: AnyNode[], seg: Segment): AnyNode[] {
  const out: AnyNode[] = [];
  for (const node of nodes) {
    const $n = $0(node);
    let found: AnyNode[];
    switch (seg.kind) {
      case 'children':
        found = $n.children().toArray();
        break;
      case 'class':
        found = $n.find(seg.name.trim().split(/\s+/).map((c) => `.${cssEscape(c)}`).join('')).toArray();
        break;
      case 'id':
        found = $n.find(`[id="${seg.name}"]`).toArray();
        break;
      case 'tag':
        found = $n.find(seg.name).toArray();
        break;
      case 'text':
        found = $n
          .find('*')
          .toArray()
          .filter((el) => $0(el).contents().toArray().some((c) => c.type === 'text' && (c as unknown as { data: string }).data.includes(seg.name)));
        break;
      default:
        found = $n.find(seg.name).toArray();
    }
    out.push(...applyIndex(found, seg));
  }
  return out;
}

function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, '\\$1');
}

const GETTERS = new Set(['text', 'textNodes', 'ownText', 'html', 'all', 'href', 'src', 'content', 'value', 'title', 'alt', 'data-src', 'data-original', 'data-url']);

function getter(node: AnyNode, name: string): string {
  const $n = $0(node);
  switch (name) {
    case 'text':
      return $n.text().replace(/\s+/g, ' ').trim();
    case 'textNodes':
      return $n
        .contents()
        .toArray()
        .filter((c) => c.type === 'text')
        .map((c) => (c as unknown as { data: string }).data.trim())
        .filter(Boolean)
        .join('\n');
    case 'ownText':
      return $n
        .contents()
        .toArray()
        .filter((c) => c.type === 'text')
        .map((c) => (c as unknown as { data: string }).data)
        .join('')
        .trim();
    case 'html': {
      const clone = $0($0.html(node) ?? '');
      clone.find('script,style').remove();
      return $0.html(clone) ?? '';
    }
    case 'all':
      return $0.html(node) ?? '';
    default:
      return $n.attr(name) ?? '';
  }
}

function jsoupElements(content: unknown, rule: string): AnyNode[] {
  let nodes: AnyNode[] = toCheerio(content).toArray();
  for (const seg of splitTop(rule, '@')) {
    if (!seg.trim()) continue;
    nodes = selectSegment(nodes, parseSegment(seg));
  }
  return nodes;
}

function jsoupStrings(content: unknown, rule: string): string[] {
  const segs = splitTop(rule, '@').filter((s) => s.trim());
  const last = segs[segs.length - 1] ?? 'text';
  const isGetter = GETTERS.has(last) || (segs.length > 1 && /^[\w-]+$/.test(last) && !/^(class|id|tag|text)\./.test(last));
  const selector = isGetter ? segs.slice(0, -1) : segs;
  let nodes: AnyNode[] = toCheerio(content).toArray();
  // A bare getter applies to the content node itself; with a document root use its children.
  for (const seg of selector) nodes = selectSegment(nodes, parseSegment(seg));
  const get = isGetter ? last : 'text';
  return nodes.map((n) => getter(n, get));
}

// ---------- CSS ----------

function cssSplit(rule: string): { selector: string; get?: string } {
  const i = rule.lastIndexOf('@');
  if (i > 0 && /^[\w-]+$/.test(rule.slice(i + 1))) return { selector: rule.slice(0, i), get: rule.slice(i + 1) };
  return { selector: rule };
}

function cssElements(content: unknown, rule: string): AnyNode[] {
  return toCheerio(content).find(cssSplit(rule).selector).toArray();
}

function cssStrings(content: unknown, rule: string): string[] {
  const { selector, get } = cssSplit(rule);
  const nodes = selector.trim() ? toCheerio(content).find(selector).toArray() : toCheerio(content).toArray();
  return nodes.map((n) => getter(n, get ?? 'text'));
}

// ---------- JSONPath ----------

function jsonQuery(content: unknown, rule: string): unknown[] {
  const json = toJson(content);
  if (json === null || typeof json !== 'object') return [];
  try {
    return JSONPath({ path: rule, json: json as object, wrap: true }) as unknown[];
  } catch {
    return [];
  }
}

function jsonElements(content: unknown, rule: string): unknown[] {
  const res = jsonQuery(content, rule);
  return res.length === 1 && Array.isArray(res[0]) ? (res[0] as unknown[]) : res;
}

function jsonStrings(content: unknown, rule: string): string[] {
  return jsonQuery(content, rule).flatMap((v) => (Array.isArray(v) ? v.map(stringify) : [stringify(v)]));
}

// ---------- XPath ----------

// xpath's typings omit parse(), which is the only API that accepts { isHtml } for HTML documents.
interface XPathExpr {
  select(opts: { node: unknown; isHtml: boolean }): unknown;
  evaluateString(opts: { node: unknown; isHtml: boolean }): string;
}
const parseXPath = (xpath as unknown as { parse(e: string): XPathExpr }).parse;

function xpathSelect(content: unknown, rule: string): unknown {
  const node = toLinkedomNode(content);
  try {
    return parseXPath(rule).select({ node, isHtml: true });
  } catch {
    try {
      return parseXPath(rule).evaluateString({ node, isHtml: true });
    } catch {
      return [];
    }
  }
}

function xpathElements(content: unknown, rule: string): unknown[] {
  const r = xpathSelect(content, rule);
  return Array.isArray(r) ? r : [];
}

function xpathStrings(content: unknown, rule: string): string[] {
  const r = xpathSelect(content, rule);
  if (!Array.isArray(r)) return [String(r)];
  return r.map((n: { nodeType: number; value?: string; data?: string; textContent?: string }) =>
    n.nodeType === 2 ? (n.value ?? '') : n.nodeType === 3 ? (n.data ?? '') : (n.textContent ?? '').trim(),
  );
}

// ---------- Regex ----------

function regexElements(content: unknown, rule: string): RegexMatch[] {
  const text = stringify(content);
  let re: RegExp;
  try {
    re = new RegExp(rule, 'g');
  } catch {
    return [];
  }
  return [...text.matchAll(re)].map((m) => new RegexMatch([...m].map((g) => g ?? '')));
}

// ---------- combination ----------

function combine<T>(lists: (() => T[])[], op: Combinator): T[] {
  if (op === '||') {
    for (const get of lists) {
      const r = get();
      if (r.length && r.some((x) => stringify(x).trim())) return r;
    }
    return [];
  }
  const results = lists.map((get) => get());
  if (op === '%%') {
    const out: T[] = [];
    const max = Math.max(0, ...results.map((r) => r.length));
    for (let i = 0; i < max; i++) for (const r of results) if (i < r.length) out.push(r[i]!);
    return out;
  }
  return results.flat();
}

export class Analyzer implements JsHost {
  constructor(
    public content: unknown,
    public baseUrl: string,
    public vars: Map<string, string> = new Map(),
    public bindings: JsBindings = {},
  ) {}

  /** Same variables and bindings, different content (e.g. one list element). */
  child(content: unknown): Analyzer {
    return new Analyzer(content, this.baseUrl, this.vars, this.bindings);
  }

  /**
   * Run a JS piece. Elements cross as Jsoup-style objects (what Legado scripts expect) and come
   * back as nodes. A trailing `##regex##replacement` is applied to the result, as Legado does,
   * when the text only compiles without it.
   */
  private js(code: string, result: unknown): unknown {
    let source = code;
    let rep: ReturnType<typeof splitReplace> | undefined;
    if (code.includes('##') && !compiles(code)) {
      const r = splitReplace(code);
      if (r.regex !== undefined && compiles(r.rule)) {
        source = r.rule;
        rep = r;
      }
    }
    const out = fromJs(
      evalJs(source, this, {
        ...this.bindings,
        result: toJs(result),
        src: stringify(this.content),
        content: this.content,
      }),
    );
    if (!rep) return out;
    return Array.isArray(out) ? out.map((v) => applyReplace(stringify(v), rep!)) : applyReplace(stringify(out), rep);
  }

  /** Strip `@put:{…}` (evaluated now) and substitute `@get:{key}`. */
  private prepare(rule: string): string {
    let r = rule.replace(/@put:(\{[^}]+\})/gi, (_, json: string) => {
      try {
        const map = parseLooseJson(json) as Record<string, string>;
        for (const [k, v] of Object.entries(map)) this.vars.set(k, this.getString(v));
      } catch {
        // malformed put: ignore
      }
      return '';
    });
    r = r.replace(/@get:\{([^}]+)\}/gi, (_, key: string) => this.vars.get(key) ?? '');
    return r;
  }

  /** `{{rule or js}}` and `{$.json}` inside a string. */
  private template(rule: string): string {
    let out = rule.replace(/\{\{([\s\S]+?)\}\}/g, (_, inner: string) => {
      const t = inner.trim();
      if (/^(@@|@css:|@json:|@xpath:|\$\.|\$\[|\/\/)/i.test(t)) return this.getString(t);
      // `{{@a.1@text}}`: a leading @ marks a default-syntax rule inside a template.
      if (/^@[^@]/.test(t)) return this.getString(t.slice(1));
      try {
        return stringify(this.js(t, this.content));
      } catch {
        return '';
      }
    });
    out = out.replace(/\{(\$\.[^{}]+)\}/g, (_, path: string) => jsonStrings(this.content, path)[0] ?? '');
    return out;
  }

  private modeStrings(content: unknown, rule: string): string[] {
    if (!rule) return [stringify(content)];
    if (content instanceof RegexMatch) {
      return [rule.replace(/\$(\d+)/g, (_, n: string) => content.groups[Number(n)] ?? '')];
    }
    const { mode, rule: r } = detectMode(rule, content);
    // A plain absolute URL where a rule is expected (e.g. a fixed tocUrl) is the value itself.
    if (mode === 'jsoup' && /^https?:\/\/\S+$/i.test(r)) return [r];
    switch (mode) {
      case 'json':
        return jsonStrings(content, r);
      case 'xpath':
        return xpathStrings(content, r);
      case 'css':
        return cssStrings(content, r);
      case 'regex':
        return regexElements(content, r).map((m) => m.groups[0] ?? '');
      default:
        return jsoupStrings(content, r);
    }
  }

  private modeElements(content: unknown, rule: string): unknown[] {
    const { mode, rule: r } = detectMode(rule, content);
    switch (mode) {
      case 'json':
        return jsonElements(content, r);
      case 'xpath':
        return xpathElements(content, r);
      case 'css':
        return cssElements(content, r);
      case 'regex':
        return regexElements(content, r);
      default:
        return jsoupElements(content, r);
    }
  }

  private plainStrings(content: unknown, ruleText: string): string[] {
    const rep = splitReplace(ruleText);
    let values: string[];
    if (/\{\{[\s\S]+?\}\}|\{\$\./.test(rep.rule)) {
      values = [this.child(content).template(rep.rule)];
    } else {
      const { parts, op } = splitCombinators(rep.rule);
      values = combine(
        parts.map((p) => () => this.modeStrings(content, p)),
        op,
      );
    }
    return rep.regex === undefined ? values : values.map((v) => applyReplace(v, rep)).filter((v, _, a) => v || a.length === 1);
  }

  /** `asString`: JS pieces get the previous result as one string (Legado's getString), not a list. */
  getStringList(rule: string, asString = false): string[] {
    if (!rule?.trim()) return [];
    const only = rule.trim().match(/^@get:\{([^}]+)\}$/i);
    if (only) return [this.vars.get(only[1]!) ?? ''];
    const prepared = this.prepare(rule);
    // Each piece consumes the previous piece's result; the first one reads the content.
    let value: unknown = this.content;
    let first = true;
    for (const seg of splitJs(prepared)) {
      if (seg.kind === 'js') {
        const input = first
          ? jsInput(value)
          : Array.isArray(value)
            ? asString
              ? value.map(stringify).join('\n')
              : value.length === 1
                ? value[0]
                : value
            : value;
        value = this.js(seg.text, input);
      } else {
        const input = first ? value : Array.isArray(value) ? value.map(stringify).join('\n') : value;
        value = this.plainStrings(input, seg.text);
      }
      first = false;
    }
    if (Array.isArray(value)) return value.map(stringify);
    return value === undefined || value === null ? [] : [stringify(value)];
  }

  getString(rule: string): string {
    return this.getStringList(rule, true).join('\n').trim();
  }

  getElements(rule: string): unknown[] {
    if (!rule?.trim()) return [];
    const prepared = this.prepare(rule);
    let value: unknown = this.content;
    let first = true;
    for (const seg of splitJs(prepared)) {
      if (seg.kind === 'js') {
        value = this.js(seg.text, first ? jsInput(value) : value);
        if (typeof value === 'string' && looksJson(value)) value = toJson(value);
      } else {
        const { parts, op } = splitCombinators(seg.text);
        const base = value;
        const many = !first && Array.isArray(base);
        value = combine(
          parts.map((p) => () => (many ? (base as unknown[]).flatMap((b) => this.modeElements(b, p)) : this.modeElements(base, p))),
          op,
        );
      }
      first = false;
    }
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
  }

  getElement(rule: string): unknown {
    return this.getElements(rule)[0];
  }
}

