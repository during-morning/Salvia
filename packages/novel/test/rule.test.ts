import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Analyzer } from '../src/rule/analyze.ts';
import { splitCombinators, splitJs, splitReplace } from '../src/rule/split.ts';
import { sourceObject } from '../src/rule/js.ts';
import { variableMethods } from '../src/flow.ts';

const html = readFileSync(new URL('./fixtures/search.html', import.meta.url), 'utf8');
const a = new Analyzer(html, 'https://example.com/search');

describe('split', () => {
  it('combinators stay out of brackets and quotes', () => {
    expect(splitCombinators('$.a[?(@.x && @.y)]&&$.b').parts).toEqual(['$.a[?(@.x && @.y)]', '$.b']);
    expect(splitCombinators("//a[@t='1||2']||tag.b")).toEqual({ parts: ["//a[@t='1||2']", 'tag.b'], op: '||' });
  });
  it('replace and js pieces', () => {
    expect(splitReplace('text##\\s+##-')).toEqual({ rule: 'text', regex: '\\s+', replacement: '-', first: false });
    expect(splitReplace('text##作者：(.*)##$1###')).toMatchObject({ regex: '作者：(.*)', replacement: '$1', first: true });
    expect(splitJs('tag.a@href<js>result+1</js>')).toEqual([
      { kind: 'rule', text: 'tag.a@href' },
      { kind: 'js', text: 'result+1' },
    ]);
    expect(splitJs('@js:1+1')).toEqual([{ kind: 'js', text: '1+1' }]);
  });
});

describe('Legado default syntax', () => {
  it('lists and fields', () => {
    const list = a.getElements('class.novelslist2@tag.li');
    expect(list).toHaveLength(2);
    const b = a.child(list[0]);
    expect(b.getString('class.s2@tag.a@text')).toBe('诡秘之主');
    expect(b.getString('class.s2@tag.a@href')).toBe('/book/1/');
    expect(b.getString('class.s4@text')).toBe('爱潜水的乌贼');
    expect(b.getString('tag.span.-1@text')).toBe('第一千三百九十四章 序列0');
  });
  it('indexes and exclusions', () => {
    expect(a.getStringList('id.list@tag.dd@tag.a@text')).toHaveLength(4);
    expect(a.getStringList('id.list@tag.dd!0@tag.a@text')).toEqual(['第一章 绯红', '第二章 情况', '第三章 新']);
    expect(a.getStringList('id.list@tag.dd[1:2]@tag.a@text')).toEqual(['第一章 绯红', '第二章 情况']);
    expect(a.getStringList('id.list@tag.dd[-1]@tag.a@text')).toEqual(['第三章 新']);
  });
  it('replace, text getter and ##', () => {
    expect(a.getString('id.info@tag.p@text##作\\s*者：')).toBe('爱潜水的乌贼');
    expect(a.getString('id.info@tag.p@text##作\\s*者：(.*)##$1###')).toBe('爱潜水的乌贼');
  });
  it('html getter drops scripts', () => {
    const h = a.getString('id.content@html');
    expect(h).toContain('第一段内容');
    expect(h).not.toContain('ads()');
  });
  it('combinators', () => {
    expect(a.getString('class.none@text||id.info@tag.h1@text')).toBe('诡秘之主');
    expect(a.getStringList('class.s2@tag.a@text&&class.s4@text')).toEqual(['诡秘之主', '宿命之环', '爱潜水的乌贼', '爱潜水的乌贼']);
    expect(a.getStringList('class.s2@tag.a@text%%class.s4@text')).toEqual(['诡秘之主', '爱潜水的乌贼', '宿命之环', '爱潜水的乌贼']);
  });
});

describe('other modes', () => {
  it('@css', () => {
    expect(a.getStringList('@css:.s2 > a@href')).toEqual(['/book/1/', '/book/2/']);
    expect(a.getElements('@css:#list dd')).toHaveLength(4);
    expect(a.getString('@css:#info img@src')).toBe('/cover/1.jpg');
  });
  it('xpath', () => {
    expect(a.getStringList('//span[@class="s2"]/a/@href')).toEqual(['/book/1/', '/book/2/']);
    const items = a.getElements('//div[@class="novelslist2"]//li');
    expect(items).toHaveLength(2);
    expect(a.child(items[1]).getString('//span[@class="s4"]/text()')).toBe('爱潜水的乌贼');
  });
  it('json, templates and js', () => {
    const json = JSON.stringify({ data: { list: [{ id: 7, name: '书一', author: { n: '甲' } }, { id: 8, name: '书二', author: { n: '乙' } }] } });
    const j = new Analyzer(json, 'https://api.example.com/');
    const list = j.getElements('$.data.list');
    expect(list).toHaveLength(2);
    const b = j.child(list[1]);
    expect(b.getString('$.name')).toBe('书二');
    expect(b.getString('name')).toBe('书二'); // bare rule on JSON content
    expect(b.getString('author.n')).toBe('乙');
    expect(b.getString('https://x.com/book/{$.id}.html')).toBe('https://x.com/book/8.html');
    expect(b.getString('/book/{{$.id}}/{{1+1}}')).toBe('/book/8/2');
    expect(b.getString('$.name@js:result + "!"')).toBe('书二!');
    expect(j.getElements('@js:JSON.parse(result).data.list.map(x => ({t: x.name}))').map((x) => j.child(x).getString('$.t'))).toEqual(['书一', '书二']);
  });
  it('regex all-in-one lists', () => {
    const list = a.getElements(':<a href="(/book/1/\\d+\\.html)">([^<]+)</a>');
    // 999.html (search row), 3.html (latest block), then the full list 1, 2, 3
    expect(list).toHaveLength(5);
    expect(a.child(list[2]).getString('$2')).toBe('第一章 绯红');
    expect(a.child(list[2]).getString('$1')).toBe('/book/1/1.html');
  });
  it('@put and @get', () => {
    const b = a.child(a.getElements('class.novelslist2@tag.li')[0]);
    b.getString('@put:{bid:"class.s2@tag.a@href##\\\\D"}');
    expect(b.vars.get('bid')).toBe('1');
    expect(b.getString('/api/{{java.get("bid")}}')).toBe('/api/1');
    expect(b.getString('@get:{bid}')).toBe('1');
  });
});

// Syntax seen in real Legado sources (Chloris's verified set).
describe('Legado compatibility', () => {
  const list = '<ul class="x"><li>a</li><li>b</li><li>c</li><li>d</li></ul><dl><dd>0</dd><dd>1</dd><dd>2</dd><dd>3</dd></dl>';
  const c = new Analyzer(list, 'https://example.com/');

  it('old index syntax on any segment', () => {
    expect(c.getStringList('dd.2:3@text')).toEqual(['2', '3']);
    expect(c.getStringList('.x@li.-1@text')).toEqual(['d']);
    expect(c.getStringList('tag.li.!0:1@text')).toEqual(['c', 'd']);
    expect(c.getStringList('li!0:-1@text')).toEqual(['b', 'c']);
  });

  it('@ rules inside templates', () => {
    expect(c.getString('{{@dd.1@text}}-{{@li.0@text}}')).toBe('1-a');
  });

  it('##replacement after JS', () => {
    expect(c.getString('@js:"第1章 开始"\n##第(\\d+)章##[$1]')).toBe('[1] 开始');
    expect(c.getString('@js:"a##b".split("##").join("+")')).toBe('a+b'); // ## inside the JS stays code
  });

  it('org.jsoup.Jsoup and element results in JS', () => {
    expect(c.getString('@js:org.jsoup.Jsoup.parse(src).select("li").eachText().join(",")')).toBe('a,b,c,d');
    expect(c.getString('@js:org.jsoup.Jsoup.parse(src).select("dd").last().text()')).toBe('3');
    // An element list from a rule arrives as Jsoup Elements, and Elements returned become rows.
    const rows = c.getElements('tag.li<js>result.toArray().filter((e) => e.text() !== "b")</js>');
    expect(rows.map((r) => c.child(r).getString('text'))).toEqual(['a', 'c', 'd']);
  });

  it('source object and jsLib', () => {
    const src = { bookSourceUrl: 'https://s.example', bookSourceName: 's', header: '{"X":"1"}', jsLib: 'function twice(s){return s+s} var K=7;' };
    const vars = new Map<string, string>();
    const s = new Analyzer('', src.bookSourceUrl, vars, { source: sourceObject(src, vars) });
    expect(s.getString('@js:source.key + "|" + source.getKey() + "|" + JSON.parse(source.header).X')).toBe('https://s.example|https://s.example|1');
    expect(s.getString('@js:twice("ab") + K')).toBe('abab7');
    s.getString('@js:source.setVariable("v1")');
    expect(s.getString('@js:source.getVariable()')).toBe('v1');
  });

  it('##replace inside templates, Jsoup pseudos, toNumChapter', () => {
    expect(c.getString('{{@li.0@text##a##A}}-{{@dd.1@text}}')).toBe('A-1');
    expect(c.getStringList('@css:li:matchesOwn(^[bc]$)@text')).toEqual(['b', 'c']);
    expect(c.getString('@js:java.toNumChapter("第一百二十三章 归来")')).toBe('第123章 归来');
    expect(c.getString('@js:java.toNumChapter("第十五回")')).toBe('第15回');
    expect(c.getString('@js:java.toNumChapter("第二〇二四章")')).toBe('第2024章');
  });

  it('first JS piece gets the element itself; java.getElements gives Jsoup objects; book variables', () => {
    const li = c.getElements('tag.li')[1];
    expect(c.child(li).getString('@js:result.text() + "|" + result.nextElementSibling().text()')).toBe('b|c');
    expect(c.getString('@js:java.getElements("tag.dd").size()')).toBe('4');
    const vars = new Map<string, string>();
    const b = new Analyzer('', 'https://x/', vars, { book: variableMethods(vars, 'book') });
    b.getString('@js:book.putVariable("p", "9")');
    expect(b.getString('@js:book.getVariable("p")')).toBe('9');
    expect(c.getString('https://example.com/toc')).toBe('https://example.com/toc');
  });

  it('symmetric crypto round trip', () => {
    const r = c.getString(
      '@js:var k="1234567890abcdef"; var x=java.createSymmetricCrypto("AES/CBC/PKCS5Padding", k, k); x.decryptStr(x.encryptBase64("你好"))',
    );
    expect(r).toBe('你好');
  });
});
