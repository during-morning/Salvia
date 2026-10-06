import { load } from 'cheerio';
import { applyReplace, splitReplace, splitTop } from './rule/split.ts';

/** Turn chapter HTML into plain paragraphs: one paragraph per line, no indentation. */
export function htmlToText(html: string): string {
  if (!/<[a-z!/][^>]*>/i.test(html)) return normalize(html);
  const $ = load(html, null, false);
  $('script,style,noscript,iframe,ins,button,select,input').remove();
  $('br').replaceWith('\n');
  $('p,div,h1,h2,h3,h4,h5,h6,li,tr,dd,dt,section,article').each((_, el) => {
    $(el).prepend('\n').append('\n');
  });
  return normalize($.root().text());
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/&nbsp;| |　/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Ad phrases sites splice into story lines: removed up to the end of their sentence.
const INLINE_ADS = /(请记住本站|本站域名|最新网址|天才一秒记住|手机版阅读网址|手机用户请(浏览|访问)|一秒记住|笔趣阁|请收藏本站|章节错误[,，]?点此举报)[^。！？\n]*[。！？]?/g;

// Whole lines that are site chrome rather than story text.
const JUNK = [
  /^(上一章|下一章|返回目录|目录|上一页|下一页|返回书页|加入书签|投推荐票|推荐阅读)$/,
  /本章未完.*点击下一页/,
  /^\s*[-=_*]{3,}\s*$/,
];

/**
 * Clean chapter text: drop site chrome, a repeated chapter title on the first line, and apply the
 * source's `replaceRegex` (Legado `##regex##replacement` rules, one or more joined by `&&`… or newlines).
 */
export function cleanContent(text: string, title: string, replaceRegex?: string): string {
  let lines = text.split('\n');
  const t = title.replace(/\s+/g, '');
  // The page often repeats the chapter title (sometimes with the book name) as its first line.
  const isTitle = (line: string) => {
    const l = line.replace(/\s+/g, '');
    return !!t && (l === t || (l.includes(t) && l.length <= t.length + 12));
  };
  while (lines.length && isTitle(lines[0]!)) lines.shift();
  lines = lines.map((l) => l.replace(INLINE_ADS, '').trim()).filter((l) => l && !JUNK.some((re) => re.test(l)));
  let out = lines.join('\n');
  if (replaceRegex?.trim()) {
    for (const piece of replaceRegex.split(/\n/).flatMap((p) => splitTop(p, '&&'))) {
      const rule = piece.startsWith('##') ? piece : `##${piece}`;
      out = applyReplace(out, splitReplace(rule));
    }
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}
