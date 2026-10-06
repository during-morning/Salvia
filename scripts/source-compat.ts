// Run Salvia's rule engine against a set of Legado book sources and summarise what works.
//   npx tsx scripts/source-compat.ts <sources.json> [--full N] [--only name]
// Stage 1: search with each source's checkKeyWord. Stage 2 (--full N): for N sources that found
// something, also book info → table of contents → first chapter's text.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSources, type BookSource } from '../packages/novel/src/source.ts';
import { bookInfo, content, search, toc } from '../packages/novel/src/flow.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: source-compat.ts <sources.json> [--full N]');
const fullN = Number(process.argv[process.argv.indexOf('--full') + 1] ?? 0) || 0;
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;

let sources = parseSources(readFileSync(file, 'utf8')).filter((s) => (s.bookSourceType ?? 0) === 0 && s.searchUrl);
if (only) sources = sources.filter((s) => s.bookSourceName.includes(only));
console.log(`${sources.length} text sources with a searchUrl`);

const withTimeout = (ms: number) => AbortSignal.timeout(ms);
type Outcome = { source: BookSource; stage: string; ok: boolean; detail: string; ms: number };
const results: Outcome[] = [];

function category(msg: string): string {
  if (/timeout|aborted/i.test(msg)) return 'timeout';
  if (/HTTP (\d+)/.test(msg)) return `HTTP ${msg.match(/HTTP (\d+)/)![1]}`;
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/.test(msg)) return 'DNS';
  if (/ECONNRESET|ECONNREFUSED|socket|fetch failed|certificate|CERT/i.test(msg)) return 'network';
  if (/is not defined|is not a function|Cannot read|SyntaxError|ReferenceError|TypeError/.test(msg)) return `js: ${msg.slice(0, 60)}`;
  return msg.slice(0, 60);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

let done = 0;
await pool(sources, 16, async (s) => {
  const key = s.ruleSearch?.checkKeyWord || '我的';
  const t0 = Date.now();
  try {
    const books = await search(s, key, withTimeout(15_000));
    results.push({ source: s, stage: 'search', ok: books.length > 0, detail: books.length ? `${books.length}` : 'empty', ms: Date.now() - t0 });
  } catch (err) {
    results.push({ source: s, stage: 'search', ok: false, detail: category(String((err as Error)?.message ?? err)), ms: Date.now() - t0 });
  }
  if (++done % 50 === 0) process.stderr.write(`  ${done}/${sources.length}\n`);
});

const ok = results.filter((r) => r.ok);
const byDetail = new Map<string, number>();
for (const r of results.filter((r) => !r.ok)) byDetail.set(r.detail, (byDetail.get(r.detail) ?? 0) + 1);
console.log(`\nsearch: ${ok.length}/${results.length} ok`);
for (const [d, n] of [...byDetail].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)}  ${d}`);

const full: Outcome[] = [];
if (fullN) {
  const sample = ok.slice(0, fullN).map((r) => r.source);
  await pool(sample, 8, async (s) => {
    const key = s.ruleSearch?.checkKeyWord || '我的';
    const t0 = Date.now();
    let stage = 'search';
    try {
      const books = await search(s, key, withTimeout(15_000));
      const book = books[0]!;
      stage = 'info';
      await bookInfo(book, withTimeout(20_000));
      stage = 'toc';
      const chapters = await toc(book, withTimeout(60_000));
      if (!chapters.length) throw new Error('empty toc');
      stage = 'content';
      const first = chapters.find((c) => !c.isVolume)!;
      const text = await content(book, first, chapters[chapters.indexOf(first) + 1]?.url, withTimeout(20_000));
      if (text.length < 50) throw new Error(`short content (${text.length})`);
      full.push({ source: s, stage: 'done', ok: true, detail: `${chapters.length} ch, ${text.length} chars`, ms: Date.now() - t0 });
    } catch (err) {
      full.push({ source: s, stage, ok: false, detail: category(String((err as Error)?.message ?? err)), ms: Date.now() - t0 });
    }
  });
  const fok = full.filter((r) => r.ok).length;
  console.log(`\nfull flow: ${fok}/${full.length} ok`);
  const fail = new Map<string, number>();
  for (const r of full.filter((r) => !r.ok)) fail.set(`${r.stage}: ${r.detail}`, (fail.get(`${r.stage}: ${r.detail}`) ?? 0) + 1);
  for (const [d, n] of [...fail].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${d}`);
}

const out = process.env.REPORT ?? 'source-compat-report.json';
writeFileSync(
  out,
  JSON.stringify(
    [...results, ...full].map((r) => ({ name: r.source.bookSourceName, url: r.source.bookSourceUrl, stage: r.stage, ok: r.ok, detail: r.detail, ms: r.ms })),
    null,
    1,
  ),
);
console.log(`\nreport: ${out}`);
process.exit(0);
