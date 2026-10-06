import { describe, expect, it } from 'vitest';
import { mergeTranslation } from '../src/tag.ts';

describe('mergeTranslation', () => {
  it('puts each translated line after its original', () => {
    const out = mergeTranslation({
      lrc: '[00:01.00]Hello\n[00:02.00]World',
      translation: '[00:01.00]你好\n[00:02.00]世界',
    });
    expect(out.split('\n')).toEqual(['[00:01.00]Hello', '[00:01.00]你好', '[00:02.00]World', '[00:02.00]世界']);
  });
});
