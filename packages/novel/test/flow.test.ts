import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import iconv from 'iconv-lite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookInfo, content, search, toc } from '../src/flow.ts';
import { Analyzer } from '../src/rule/analyze.ts';
import type { BookSource } from '../src/source.ts';
import { absolute, buildRequest, encodeValue, isNavLink } from '../src/url.ts';

// A small GBK "biquge-like" site: POST search, paged toc, chapters split over two pages.
let server: Server;
let base = '';
let lastSearchBody = '';

function page(body: string): Buffer {
  return iconv.encode(`<html><head><meta charset="gbk"></head><body>${body}</body></html>`, 'gbk');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'text/html'); // no charset: must be sniffed from <meta>
    if (url.pathname === '/search.php') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastSearchBody = Buffer.concat(chunks).toString('latin1');
        const encoded = lastSearchBody.split('=')[1] ?? '';
        const bytes = Buffer.from((encoded.match(/%[0-9A-F]{2}/gi) ?? []).map((h) => parseInt(h.slice(1), 16)));
        const key = iconv.decode(bytes, 'gbk');
        res.end(
          page(`<div class="result-list"><div class="result-item">
            <a class="result-game-item-title-link" href="/book/7/"><span>${key}之书</span></a>
            <p class="result-game-item-info-tag"><span>作者：</span><span>无名氏</span></p>
          </div></div>`),
        );
      });
      return;
    }
    if (url.pathname === '/book/7/') {
      res.end(
        page(`<div id="info"><h1>测试之书</h1><p>作&nbsp;&nbsp;者：无名氏</p></div><div id="intro">一本测试用的书。</div>
          <div id="list"><dl><dt>最新章节</dt><dd><a href="/book/7/2.html">第二章 下</a></dd>
          <dt>正文</dt><dd><a href="/book/7/1.html">第一章 上</a></dd></dl></div>
          <a class="next-toc" href="/book/7/index_2.html">下一页</a>`),
      );
      return;
    }
    if (url.pathname === '/book/7/index_2.html') {
      res.end(page(`<div id="list"><dl><dd><a href="/book/7/2.html">第二章 下</a></dd></dl></div>`));
      return;
    }
    if (url.pathname === '/book/7/1.html') {
      res.end(page(`<div id="content">第一章 上<br>　　甲段。<br><br>　　乙段。请记住本站域名</div><a id="next" href="/book/7/1_2.html">下一页</a>`));
      return;
    }
    if (url.pathname === '/book/7/1_2.html') {
      res.end(page(`<div id="content">　　丙段（广告）。</div><a id="next" href="/book/7/2.html">下一章</a>`));
      return;
    }
    if (url.pathname === '/book/7/2.html') {
      res.end(page(`<div id="content">　　丁段。</div><a id="next" href="/book/7/">返回目录</a>`));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

afterAll(() => server.close());

function source(): BookSource {
  return {
    bookSourceUrl: base,
    bookSourceName: '测试源',
    searchUrl: '/search.php,{"method":"POST","body":"searchkey={{key}}","charset":"gbk"}',
    ruleSearch: {
      bookList: 'class.result-list@class.result-item',
      name: 'class.result-game-item-title-link@text',
      author: 'class.result-game-item-info-tag@tag.span.1@text',
      bookUrl: 'class.result-game-item-title-link@href',
    },
    ruleBookInfo: {
      name: 'id.info@tag.h1@text',
      author: 'id.info@tag.p.0@text##作\\s*者：',
      intro: 'id.intro@text',
    },
    ruleToc: {
      chapterList: 'id.list@tag.dd',
      chapterName: 'tag.a@text',
      chapterUrl: 'tag.a@href',
      nextTocUrl: 'class.next-toc@href',
    },
    ruleContent: {
      content: 'id.content@html',
      nextContentUrl: 'id.next@href',
      replaceRegex: '##（广告）',
    },
  };
}

describe('url helpers', () => {
  it('absolute: first line only, Legado options kept', () => {
    expect(absolute('/a.html\n/b.html', 'https://s.com/x/')).toBe('https://s.com/a.html');
    expect(absolute("/c/1.html,{'webView': true}", 'https://s.com/')).toBe("https://s.com/c/1.html,{'webView': true}");
    expect(absolute('', 'https://s.com/')).toBe('');
  });
  it('nav links are not chapters', () => {
    expect(isNavLink('https://s.com/b/#', 'https://s.com/b/')).toBe(true);
    expect(isNavLink('https://s.com/b/#footer', 'https://s.com/b/')).toBe(true);
    expect(isNavLink('javascript:void(0)', 'https://s.com/b/')).toBe(true);
    expect(isNavLink('https://s.com/b/1.html', 'https://s.com/b/')).toBe(false);
    expect(isNavLink('https://s.com/b/1.html#top', 'https://s.com/b/')).toBe(false);
  });
});

describe('url rules', () => {
  it('encodes values in GBK and leaves encoded ones alone', () => {
    expect(encodeValue('诡秘', 'gbk')).toBe('%B9%EE%C3%D8');
    expect(encodeValue('%B9%EE', 'gbk')).toBe('%B9%EE');
    expect(encodeValue('a b', 'utf-8')).toBe('a%20b');
  });

  it('page variants, templates and options', () => {
    const s = { bookSourceUrl: 'https://s.com', bookSourceName: 's' };
    expect(buildRequest(s, '/s?q={{key}}&p={{page}}', { key: '书', page: 2 }).url).toBe('https://s.com/s?q=%E4%B9%A6&p=2');
    expect(buildRequest(s, '/list<,_{{page}}>.html', { page: 1 }).url).toBe('https://s.com/list.html');
    expect(buildRequest(s, '/list<,_{{page}}>.html', { page: 3 }).url).toBe('https://s.com/list_3.html');
    expect(buildRequest(s, '/s?q={{key}}&o={{(page-1)*20}}', { key: 'x', page: 3 }).url).toBe('https://s.com/s?q=x&o=40');
    const post = buildRequest(s, "/api,{'method':'POST','body':'k={{key}}','charset':'gbk'}", { key: '书' });
    expect(post).toMatchObject({ method: 'POST', body: 'k=%CA%E9', url: 'https://s.com/api' });
    expect(buildRequest(s, '@js:"/q/" + key', { key: 'abc' }).url).toBe('https://s.com/q/abc');
  });
});

describe('java.ajax', () => {
  it('fetches synchronously from source JS, honouring charset', async () => {
    // java.ajax blocks this thread, so the site must live in another process.
    const child = spawn(process.execPath, [
      '-e',
      `const h=require('http');const s=h.createServer((q,r)=>r.end(Buffer.from('${iconv.encode('<p>丁段</p>', 'gbk').toString('hex')}','hex')));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`,
    ]);
    try {
      const port = await new Promise<string>((r) => child.stdout.once('data', (d: Buffer) => r(d.toString().trim())));
      const a = new Analyzer('', base);
      const html = a.getString(`@js:java.ajax('http://127.0.0.1:${port}/x,{"charset":"gbk"}')`);
      expect(html).toContain('丁段');
    } finally {
      child.kill();
    }
  });
});

describe('flow against a GBK site', () => {
  it('search → info → toc → content', async () => {
    const src = source();
    const books = await search(src, '诡秘');
    expect(lastSearchBody).toBe('searchkey=%B9%EE%C3%D8');
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ name: '诡秘之书', author: '无名氏', bookUrl: `${base}/book/7/` });

    const book = await bookInfo(books[0]!);
    expect(book).toMatchObject({ name: '测试之书', author: '无名氏', intro: '一本测试用的书。', tocUrl: `${base}/book/7/` });

    const chapters = await toc(book);
    // "Latest" duplicate dropped, page 2 followed.
    expect(chapters.map((c) => c.title)).toEqual(['第一章 上', '第二章 下']);

    const text = await content(book, chapters[0]!, chapters[1]!.url);
    expect(text).toBe('甲段。\n乙段。\n丙段。');
    expect(await content(book, chapters[1]!)).toBe('丁段。');
  });
});
