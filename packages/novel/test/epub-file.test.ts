import { readFileSync } from 'node:fs';
import { strFromU8 } from 'fflate';
import { expect, it } from 'vitest';
import { checkEpub } from './epub.test.ts';

// Validates a real file: EPUB_FILE=path npx vitest run packages/novel/test/epub-file.test.ts
it.runIf(!!process.env.EPUB_FILE)('real epub file is valid', () => {
  const { files, opf } = checkEpub(new Uint8Array(readFileSync(process.env.EPUB_FILE!)));
  const chapters = Object.keys(files).filter((f) => /c\d+\.xhtml$/.test(f));
  console.log('title', opf.getElementsByTagName('dc:title')[0]?.textContent, 'chapters', chapters.length);
  console.log(strFromU8(files[chapters[0]!]!).slice(0, 600));
  expect(chapters.length).toBeGreaterThan(0);
});
