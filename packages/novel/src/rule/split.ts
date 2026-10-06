/**
 * Low-level splitting of Legado rule strings, aware of brackets and quotes so that
 * `$.a[?(@.x && @.y)]` or `//a[@x='1||2']` are not split in the wrong place.
 */

const OPEN = '([{';
const CLOSE = ')]}';

/** Indexes where `token` occurs at bracket depth 0 and outside quotes. */
function topLevel(s: string, token: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && s.startsWith(token, i)) {
      out.push(i);
      i += token.length - 1;
    }
  }
  return out;
}

export function splitTop(s: string, token: string): string[] {
  const idx = topLevel(s, token);
  if (!idx.length) return [s];
  const parts: string[] = [];
  let last = 0;
  for (const i of idx) {
    parts.push(s.slice(last, i));
    last = i + token.length;
  }
  parts.push(s.slice(last));
  return parts;
}

export type Combinator = '&&' | '||' | '%%' | undefined;

/** Split on the first combinator found (Legado only mixes one kind per level). */
export function splitCombinators(rule: string): { parts: string[]; op: Combinator } {
  for (const op of ['&&', '||', '%%'] as const) {
    const parts = splitTop(rule, op);
    if (parts.length > 1) return { parts: parts.map((p) => p.trim()), op };
  }
  return { parts: [rule.trim()], op: undefined };
}

/**
 * Peel a trailing `##regex##replacement` (or `###` for replace-first) off a rule.
 * Legado puts it at the end of the rule string.
 */
export function splitReplace(rule: string): { rule: string; regex?: string; replacement: string; first: boolean } {
  // `##` inside a `{{…}}` template belongs to the inner rule, not to this one.
  let i = -1;
  for (let k = 0, depth = 0; k < rule.length - 1; k++) {
    if (rule.startsWith('{{', k)) {
      depth++;
      k++;
    } else if (rule.startsWith('}}', k) && depth > 0) {
      depth--;
      k++;
    } else if (depth === 0 && rule.startsWith('##', k)) {
      i = k;
      break;
    }
  }
  if (i < 0) return { rule, replacement: '', first: false };
  const head = rule.slice(0, i);
  let rest = rule.slice(i + 2);
  let first = false;
  if (rest.endsWith('###')) {
    first = true;
    rest = rest.slice(0, -3);
  }
  const j = rest.indexOf('##');
  const regex = j < 0 ? rest : rest.slice(0, j);
  const replacement = j < 0 ? '' : rest.slice(j + 2);
  return { rule: head, regex, replacement, first };
}

export function applyReplace(value: string, r: { regex?: string; replacement: string; first: boolean }): string {
  if (!r.regex) return value;
  let re: RegExp;
  try {
    re = new RegExp(r.regex, r.first ? 'm' : 'gm');
  } catch {
    return value.split(r.regex).join(r.replacement);
  }
  if (r.first) {
    // Legado "###": take the first match and use the replacement as a template for it.
    const m = value.match(re);
    return m ? m[0].replace(re, r.replacement) : '';
  }
  return value.replace(re, r.replacement);
}

export interface JsSegment {
  kind: 'rule' | 'js';
  text: string;
}

/**
 * Break a rule into plain-rule and JS pieces, in order: `rule<js>code</js>rule2` and `rule@js:code`.
 * Each piece consumes the previous piece's result.
 */
export function splitJs(rule: string): JsSegment[] {
  const out: JsSegment[] = [];
  let rest = rule;
  for (;;) {
    const open = rest.search(/<js>/i);
    const at = rest.search(/@js:/i);
    if (open < 0 && at < 0) break;
    if (at >= 0 && (open < 0 || at < open)) {
      if (rest.slice(0, at).trim()) out.push({ kind: 'rule', text: rest.slice(0, at).trim() });
      out.push({ kind: 'js', text: rest.slice(at + 4) });
      return out;
    }
    const close = rest.toLowerCase().indexOf('</js>', open);
    if (rest.slice(0, open).trim()) out.push({ kind: 'rule', text: rest.slice(0, open).trim() });
    out.push({ kind: 'js', text: rest.slice(open + 4, close < 0 ? undefined : close) });
    if (close < 0) return out;
    rest = rest.slice(close + 5);
  }
  if (rest.trim() || !out.length) out.push({ kind: 'rule', text: rest.trim() });
  return out;
}
