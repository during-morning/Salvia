import { randomUUID } from 'node:crypto';
import { strToU8, zipSync, type Zippable } from 'fflate';

export interface EpubChapter {
  title: string;
  /** Plain text, one paragraph per line. */
  text: string;
  isVolume?: boolean;
}

export interface EpubBook {
  title: string;
  author?: string;
  intro?: string;
  language?: string;
  cover?: { data: Uint8Array; mime: string };
  chapters: EpubChapter[];
  source?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// XML 1.0 forbids most control characters; scraped text sometimes contains them.
function xmlSafe(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

function page(title: string, body: string, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;
}

const CSS = `body { margin: 0 5%; line-height: 1.8; }
h1, h2 { text-align: center; font-weight: bold; margin: 1.5em 0 1em; }
h1 { font-size: 1.4em; } h2 { font-size: 1.2em; }
p { text-indent: 2em; margin: 0 0 0.6em; text-align: justify; }
.cover { text-align: center; margin: 0; padding: 0; } .cover img { max-width: 100%; max-height: 100%; }
.title-page { text-align: center; margin-top: 30%; } .title-page .author { margin-top: 2em; }
.intro p { text-indent: 2em; }
`;

/**
 * Build an EPUB 3 file (with an EPUB 2 NCX for older readers). The `mimetype` entry is first and
 * stored uncompressed, as the spec requires.
 */
export function buildEpub(book: EpubBook): Uint8Array {
  const lang = book.language ?? 'zh';
  const id = `urn:uuid:${randomUUID()}`;
  const files: Zippable = {};
  const manifest: string[] = [];
  const spine: string[] = [];
  const navItems: string[] = [];
  const ncxPoints: string[] = [];

  files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  files['OEBPS/style.css'] = strToU8(CSS);
  manifest.push('<item id="css" href="style.css" media-type="text/css"/>');

  if (book.cover) {
    const ext = book.cover.mime === 'image/png' ? 'png' : 'jpg';
    files[`OEBPS/cover.${ext}`] = [book.cover.data, { level: 0 }];
    manifest.push(`<item id="cover-image" href="cover.${ext}" media-type="${book.cover.mime}" properties="cover-image"/>`);
    files['OEBPS/cover.xhtml'] = strToU8(page('封面', `<div class="cover"><img src="cover.${ext}" alt="${esc(book.title)}"/></div>`, lang));
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="no"/>');
  }

  const intro = book.intro?.trim()
    ? `<div class="intro">${xmlSafe(book.intro)
        .split(/\n+/)
        .map((l) => `<p>${esc(l.trim())}</p>`)
        .join('\n')}</div>`
    : '';
  files['OEBPS/title.xhtml'] = strToU8(
    page(book.title, `<div class="title-page"><h1>${esc(xmlSafe(book.title))}</h1>${book.author ? `<p class="author">${esc(xmlSafe(book.author))}</p>` : ''}</div>${intro}`, lang),
  );
  manifest.push('<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>');
  spine.push('<itemref idref="title"/>');

  book.chapters.forEach((ch, i) => {
    const name = `c${String(i + 1).padStart(5, '0')}`;
    const title = esc(xmlSafe(ch.title));
    const body = ch.isVolume
      ? `<h1>${title}</h1>`
      : `<h2>${title}</h2>\n${xmlSafe(ch.text)
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => `<p>${esc(l.trim())}</p>`)
          .join('\n')}`;
    files[`OEBPS/${name}.xhtml`] = strToU8(page(ch.title, body, lang));
    manifest.push(`<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${name}"/>`);
    navItems.push(`<li><a href="${name}.xhtml">${title}</a></li>`);
    ncxPoints.push(
      `<navPoint id="${name}" playOrder="${i + 1}"><navLabel><text>${title}</text></navLabel><content src="${name}.xhtml"/></navPoint>`,
    );
  });

  files['OEBPS/nav.xhtml'] = strToU8(
    page('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n${navItems.join('\n')}\n</ol></nav>`, lang),
  );
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${esc(xmlSafe(book.title))}</text></docTitle>
<navMap>
${ncxPoints.join('\n')}
</navMap>
</ncx>`);
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${esc(xmlSafe(book.title))}</dc:title>
${book.author ? `<dc:creator>${esc(xmlSafe(book.author))}</dc:creator>` : ''}
<dc:language>${lang}</dc:language>
${book.intro ? `<dc:description>${esc(xmlSafe(book.intro.slice(0, 2000)))}</dc:description>` : ''}
${book.source ? `<dc:source>${esc(book.source)}</dc:source>` : ''}
<meta property="dcterms:modified">${modified}</meta>
${book.cover ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>`);

  // fflate keeps insertion order, so mimetype stays the first entry.
  return zipSync(files, { level: 6 });
}

export function buildTxt(book: Pick<EpubBook, 'title' | 'author' | 'intro' | 'chapters'>): string {
  const head = [book.title, book.author ? `作者：${book.author}` : '', book.intro ? `\n${book.intro.trim()}` : ''].filter(Boolean).join('\n');
  const body = book.chapters
    .map((c) => (c.isVolume ? `\n${c.title}\n` : `${c.title}\n\n${c.text.split('\n').map((l) => `　　${l.trim()}`).join('\n')}`))
    .join('\n\n');
  return `${head}\n\n${body}\n`;
}
