import { createHash } from 'node:crypto';

export const md5 = (s: string) => createHash('md5').update(s).digest('hex');
export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36';

/** "<em>晴天</em> &amp; x" → "晴天 & x" */
export function cleanText(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Artists from "A、B / C&D" style strings. */
export function splitArtists(s: unknown): string[] {
  return cleanText(s)
    .split(/\s*(?:[、/|&;；]|,\s)\s*/)
    .filter(Boolean);
}

/** ms → "[mm:ss.xx]" */
export function lrcTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  const two = (n: number) => String(n).padStart(2, '0');
  return `[${two(m)}:${two(s)}.${two(cs)}]`;
}

/** First non-empty string. */
export function first(...values: unknown[]): string {
  for (const v of values) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s && s !== '0') return s;
  }
  return '';
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** JSONP / callback-wrapped JSON → object. */
export function unwrapJsonp<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

/**
 * Word-timed lyrics ("[15276,3719]<0,244,0>故<244,243,0>事…", 汽水 and 酷狗 KRC) → plain LRC.
 * Lines that are already LRC pass through.
 */
export function timedToLrc(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (m) out.push(lrcTime(Number(m[1])) + m[3]!.replace(/<[^>]*>/g, ''));
    else if (/^\[\d{1,2}:\d{2}/.test(line.trim())) out.push(line.trim());
  }
  return out.join('\n');
}
