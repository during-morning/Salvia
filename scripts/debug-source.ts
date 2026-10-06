// Debug one book source end to end with stack traces:
//   npx tsx scripts/debug-source.ts <sources.json> <name> [keyword]
import { readFileSync } from 'node:fs';
import { parseSources } from '../packages/novel/src/source.ts';
import { bookInfo, content, search, toc } from '../packages/novel/src/flow.ts';

const [file, name, key] = process.argv.slice(2);
const source = parseSources(readFileSync(file!, "utf8")).find((s) => s.bookSourceUrl === name) ?? parseSources(readFileSync(file!, "utf8")).find((s) => s.bookSourceName === name);
if (!source) throw new Error(`no source named ${name}`);
const word = key ?? source.ruleSearch?.checkKeyWord ?? '我的';
try {
  const books = await search(source, word, AbortSignal.timeout(20_000));
  console.log('search', books.length, books.slice(0, 3).map((b) => `${b.name} | ${b.author} | ${b.bookUrl}`));
  const book = books[0];
  if (book) {
    await bookInfo(book, AbortSignal.timeout(20_000));
    console.log('info', book.name, '|', book.author, '|', book.tocUrl);
    const chapters = await toc(book, AbortSignal.timeout(60_000));
    console.log('toc', chapters.length, chapters.slice(0, 2));
    const first = chapters.find((c) => !c.isVolume);
    if (first) console.log('content', JSON.stringify((await content(book, first, undefined, AbortSignal.timeout(20_000))).slice(0, 200)));
  }
} catch (err) {
  console.error((err as Error).stack ?? err);
}
process.exit(0);
