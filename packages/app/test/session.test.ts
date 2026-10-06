import { beforeAll, describe, expect, it } from 'vitest';
import { Session, TaskQueue, registerCoreCommands } from '@salvia/core';
import { installAll } from '../src/index.ts';

// Completion of commands and their values, with every module installed.
beforeAll(() => installAll());

describe('Session with modules', () => {
  it('a search without keyword explains itself; completion lists searches first', async () => {
    const s = new Session(new TaskQueue());
    await s.input('@music');
    expect(s.view().status).toMatchObject({ tone: 'error' });
    expect(s.view().status.text).toContain('@music 晴天');
    expect(s.commandList().slice(0, 3).map((c) => c.name)).toEqual(['novel', 'music', 'music:netease']);
  });
});

describe('completion', () => {
  const session = new Session(new TaskQueue());
  registerCoreCommands(session);
  session.registerTargets('novel', () => [{ value: '笔趣阁', meta: '书源' }, { value: '维基文库（中文）' }]);
  const fills = (text: string) => session.complete(text).map((c) => c.fill ?? `hint:${c.title}`);

  it('command names: prefix first, then names that contain the text', () => {
    expect(fills('@mu')[0]).toBe('@music ');
    expect(fills('@mu')).toContain('@music:qq-music ');
    expect(fills('@qq')).toContain('@music:qq-music ');
    expect(fills('@log')[0]).toBe('@login ');
  });

  it('argument values after a space, filtered by what is typed', () => {
    expect(fills('@login ')).toEqual(['@login netease ', '@login qqmusic ', '@login spotify ', '@login bilibili ', '@login douyin ']);
    expect(fills('@login sp')).toEqual(['@login spotify ']);
    expect(session.complete('@login spotify')[0]?.ready).toBe(true);
    expect(fills('@proxy ')).toContain('@proxy * ');
    expect(fills('@cookie bilibili ')[0]).toMatch(/^hint:.*@login bilibili/);
  });

  it('searches show a hint, @novel: lists book sources, quoting names with spaces', () => {
    expect(fills('@music:qq-music ')[0]).toMatch(/^hint:输入歌名.*QQ音乐/);
    expect(fills('@novel:笔')).toEqual(['@novel:笔趣阁 ']);
    expect(session.complete('@help')[0]).toMatchObject({ fill: '@help ', ready: true });
  });
});

describe('command highlighting', () => {
  const s = new Session(new TaskQueue());
  it.each([
    ['@video lofi', 6],
    ['@video', 6],
    ['@vide', 0],
    ['@music:qq 晴天', 9],
    ['@music:nosuch x', 0],
    ['@login bilibili', 6],
    ['@setting', 8],
    ['@parse:netease 1', 14],
    ['晴天', 0],
  ])('%s → %i', (text, want) => expect(s.commandMark(text)).toBe(want));
});
