import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySubscription, importedSources, removeSubscription, saveImported, subscriptions, type BookSource } from '../src/source.ts';

const src = (name: string): BookSource => ({ bookSourceName: name, bookSourceUrl: `https://${name}.example` });
const names = () => importedSources().map((s) => s.bookSourceName).sort();

beforeEach(() => {
  process.env.SALVIA_HOME = mkdtempSync(join(tmpdir(), 'salvia-sub-'));
});

describe('book source subscriptions', () => {
  it('an update brings new sources and removes the ones the list dropped', () => {
    saveImported([src('mine')]);
    applySubscription('https://a.example/list.json', [src('a1'), src('a2')]);
    expect(names()).toEqual(['a1', 'a2', 'mine']);
    expect(applySubscription('https://a.example/list.json', [src('a2'), src('a3')])).toEqual({ count: 2, removed: 1 });
    expect(names()).toEqual(['a2', 'a3', 'mine']);
    expect(subscriptions()).toHaveLength(1);
  });

  it('a source another subscription still lists stays; unsubscribing removes only its own', () => {
    applySubscription('https://a.example', [src('shared'), src('a')]);
    applySubscription('https://b.example', [src('shared'), src('b')]);
    applySubscription('https://a.example', [src('a')]);
    expect(names()).toEqual(['a', 'b', 'shared']);
    expect(removeSubscription('https://b.example')).toBe(2);
    expect(names()).toEqual(['a']);
    expect(removeSubscription('https://nope.example')).toBeUndefined();
    expect(subscriptions().map((s) => s.url)).toEqual(['https://a.example']);
  });
});
