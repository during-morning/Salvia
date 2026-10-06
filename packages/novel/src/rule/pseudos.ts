import type { AnyNode, Element } from 'domhandler';
import { textContent } from 'domutils';

/**
 * Jsoup pseudo-classes that book sources use and css-select lacks:
 * `:matches(regex)`, `:matchesOwn(regex)`, `:containsOwn(text)`, `:matchText`.
 * Passed to cheerio as `pseudos`, so they work in rules and in `org.jsoup.Jsoup` alike.
 */

function regex(source: string | null | undefined): RegExp | undefined {
  try {
    return new RegExp(source ?? '');
  } catch {
    return undefined;
  }
}

function ownText(el: Element): string {
  return el.children
    .filter((c: AnyNode) => c.type === 'text')
    .map((c) => (c as unknown as { data: string }).data)
    .join('');
}

export const PSEUDOS = {
  matches: (el: Element, value?: string | null) => regex(value)?.test(textContent(el)) ?? false,
  matchesOwn: (el: Element, value?: string | null) => regex(value)?.test(ownText(el)) ?? false,
  matchesown: (el: Element, value?: string | null) => regex(value)?.test(ownText(el)) ?? false,
  containsOwn: (el: Element, value?: string | null) => ownText(el).includes(value ?? ''),
  containsown: (el: Element, value?: string | null) => ownText(el).includes(value ?? ''),
  matchText: (el: Element) => ownText(el).trim().length > 0,
};

/** cheerio `load` options carrying the pseudos. */
export const CHEERIO_OPTIONS = { pseudos: PSEUDOS } as const;
