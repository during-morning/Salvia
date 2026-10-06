// Manual live check: npx tsx packages/novel/test/live.ts [keyword]
import { builtinSources } from '../src/source.ts';
import { bookInfo, content, search, toc } from '../src/flow.ts';

const key = process.argv[2] ?? '紅樓夢';
for (const source of builtinSources()) {
  console.log(`== ${source.bookSourceName}`);
  const books = await search(source, key);
  console.log('search', books.length, books.slice(0, 3).map((b) => `${b.name} | ${b.author} | ${b.bookUrl}`));
  const book = books[0];
  if (!book) continue;
  await bookInfo(book);
  console.log('info', book.name, '|', book.author, '|', book.tocUrl, '|', book.intro?.slice(0, 60));
  const chapters = await toc(book);
  console.log('toc', chapters.length, chapters.slice(0, 3), chapters.at(-1));
  if (chapters[0]) {
    const text = await content(book, chapters[0], chapters[1]?.url);
    console.log('content', text.length, JSON.stringify(text.slice(0, 200)));
  }
}
