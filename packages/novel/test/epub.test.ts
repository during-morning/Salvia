import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEpub, buildTxt } from '../src/export/epub.ts';

/** Throws on any XML error. */
function parseXml(name: string, xml: string) {
  return new DOMParser({
    onError: (level, msg) => {
      if (level !== 'warning') throw new Error(`${name}: ${msg}`);
    },
  }).parseFromString(xml, 'application/xml');
}

export function checkEpub(bytes: Uint8Array) {
  // First local file header: signature, then name "mimetype" stored (method 0).
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(0); // compression method: stored
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLen))).toBe('mimetype');
  expect(new TextDecoder().decode(bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + 20))).toBe('application/epub+zip');

  const files = unzipSync(bytes);
  const container = parseXml('container.xml', strFromU8(files['META-INF/container.xml']!));
  const opfPath = container.getElementsByTagName('rootfile')[0]!.getAttribute('full-path')!;
  const opf = parseXml(opfPath, strFromU8(files[opfPath]!));
  const items = Array.from(opf.getElementsByTagName('item'));
  for (const item of items) {
    const href = `OEBPS/${item.getAttribute('href')}`;
    expect(files[href], `manifest file ${href}`).toBeDefined();
    if (/xhtml|ncx/.test(item.getAttribute('media-type') ?? '')) parseXml(href, strFromU8(files[href]!));
  }
  const ids = new Set(items.map((i) => i.getAttribute('id')));
  for (const ref of Array.from(opf.getElementsByTagName('itemref'))) expect(ids.has(ref.getAttribute('idref'))).toBe(true);
  expect(items.some((i) => i.getAttribute('properties') === 'nav')).toBe(true);
  return { files, opf };
}

describe('epub', () => {
  it('is a structurally valid EPUB 3 with escaped content', () => {
    const bytes = buildEpub({
      title: '测试 & <书>',
      author: '作者"甲"',
      intro: '简介第一行\n简介第二行',
      cover: { data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' },
      chapters: [
        { title: '第一卷', text: '', isVolume: true },
        { title: '第一章 <开始>', text: '第一段 a < b && c > d\n\u0007第二段' },
        { title: '第二章', text: '内容' },
      ],
    });
    const { files, opf } = checkEpub(bytes);
    expect(opf.getElementsByTagName('dc:title')[0]!.textContent).toBe('测试 & <书>');
    const ch = strFromU8(files['OEBPS/c00002.xhtml']!);
    expect(ch).toContain('<p>第一段 a &lt; b &amp;&amp; c &gt; d</p>');
    expect(ch).not.toContain('\u0007');
    expect(files['OEBPS/cover.jpg']).toBeDefined();
  });

  it('txt layout', () => {
    const txt = buildTxt({ title: '书', author: '甲', chapters: [{ title: '第一章', text: '一\n二' }] });
    expect(txt).toBe('书\n作者：甲\n\n第一章\n\n　　一\n　　二\n');
  });
});
