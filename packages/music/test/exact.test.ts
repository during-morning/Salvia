import { describe, expect, it } from 'vitest';
import { exactSame } from '../src/exact.ts';

describe('exact matches on other platforms', () => {
  it('needs the same title and artists, punctuation and case aside', () => {
    const a = { title: '弱水三千', artists: ['石头', '张晓棠'], duration: 263 };
    expect(exactSame(a, { title: '弱水三千', artists: ['石头/张晓棠'], duration: 264 })).toBe(true);
    expect(exactSame(a, { title: '弱水三千 (DJ版)', artists: ['石头'] })).toBe(false);
    expect(exactSame(a, { title: '弱水三千', artists: ['周传雄'] })).toBe(false);
    expect(exactSame(a, { title: '弱水三千', artists: ['石头'], duration: 300 })).toBe(false);
    expect(exactSame({ title: 'Hello!', artists: ['Adele'] }, { title: 'hello', artists: ['ADELE'] })).toBe(true);
  });

});
