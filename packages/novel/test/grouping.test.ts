import { describe, expect, it } from 'vitest';
import { cleanAuthor, unlabel, type Book } from '../src/flow.ts';
import { addToGroups, related, type Group } from '../src/index.ts';

const book = (name: string, author: string, src = 's'): Book =>
  ({ name, author, bookUrl: `https://${src}/`, source: { bookSourceUrl: src, bookSourceName: src }, vars: new Map() }) as Book;

describe('cleanAuthor', () => {
  it.each([
    ['作者：天蚕土豆', '天蚕土豆'],
    ['天蚕土豆 分类:武侠 来源:快眼看书 更新:15分钟前', '天蚕土豆'],
    ['天蚕土豆 | 完结', '天蚕土豆'],
    ['九支书竹 著', '九支书竹'],
    ['玄幻奇幻 | 作者：九支书竹 · 完结', '九支书竹'],
    ['J.K. Rowling', 'J.K. Rowling'],
  ])('%s', (raw, want) => expect(cleanAuthor(raw)).toBe(want));
});

describe('addToGroups', () => {
  it('merges same title+author and folds author-less results in', () => {
    const groups = new Map<string, Group>();
    addToGroups(groups, book('斗破苍穹', '', 'a'));
    addToGroups(groups, book('斗破苍穹', '天蚕土豆', 'b'));
    addToGroups(groups, book('斗破 苍穹', '天蚕土豆', 'c'));
    addToGroups(groups, book('斗破苍穹', '', 'd'));
    addToGroups(groups, book('斗破苍穹', '九支书竹', 'e'));
    const list = [...groups.values()];
    expect(list.map((g) => [g.author, g.books.length])).toEqual([
      ['天蚕土豆', 4],
      ['九支书竹', 1],
    ]);
  });
});

describe('related', () => {
  it('drops results that only share a character with the query', () => {
    expect(related({ name: '青年會與拒俄義勇隊', author: '' }, '诡秘之主')).toBe(false);
    expect(related({ name: '诡秘之主', author: '爱潜水的乌贼' }, '诡秘之主')).toBe(true);
    expect(related({ name: '诡秘之主之我是愚者', author: 'x' }, '诡秘之主')).toBe(true);
    expect(related({ name: '诡秘主宰', author: 'x' }, '诡秘之主')).toBe(true);
    expect(related({ name: '某书', author: '天蚕土豆' }, '天蚕土豆')).toBe(true);
  });
});

describe('unlabel', () => {
  it('strips the page label', () => {
    expect(unlabel('最新章节：第十章 归来')).toBe('第十章 归来');
    expect(unlabel('字数：7232571')).toBe('7232571');
    expect(unlabel('第一章')).toBe('第一章');
  });
});
