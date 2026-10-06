import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAll } from '@salvia/app';
import { render } from 'ink-testing-library';
import { Session, TaskQueue, demoHandler, registerCoreCommands, resetConfigCache, type Handler } from '@salvia/core';
import { App } from '../src/tui/App.tsx';
import { HitProvider, HitRegistry } from '../src/tui/hit.tsx';
import { splitMouse } from '../src/tui/mouse.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\u001b';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const TAB = '\t';

/**
 * Waits for what the screen should show instead of sleeping a fixed time, so the tests hold under
 * load (all test files run in parallel). Fails with the last frame when it doesn't show up.
 */
async function until(frame: () => string, check: (f: string) => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check(frame())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; screen:\n${frame()}`);
    await wait(10);
  }
}

function setup(session = new Session(new TaskQueue())) {
  registerCoreCommands(session);
  const registry = new HitRegistry();
  const r = render(
    <HitProvider registry={registry}>
      <App session={session} />
    </HitProvider>,
  );
  // A click: press and release (clicks fire on release; a press that moves is a text selection).
  const click = (x: number, y: number) => {
    registry.dispatch({ x, y, kind: 'down', button: 'left', shift: false, alt: false, ctrl: false });
    registry.dispatch({ x, y, kind: 'up', button: 'left', shift: false, alt: false, ctrl: false });
  };
  const frame = () => r.lastFrame() ?? '';
  /** The screen contains `text` (or matches `re`). */
  const see = (text: string | RegExp) => until(frame, (f) => (typeof text === 'string' ? f.includes(text) : text.test(f)), `"${text}"`);
  /** `text` has left the screen. */
  const gone = (text: string) => until(frame, (f) => !f.includes(text), `"${text}" to disappear`);
  return { ...r, session, registry, click, frame, see, gone };
}

beforeAll(() => installAll());

// Each test starts with an empty download history.
beforeEach(() => {
  process.env.SALVIA_HOME = mkdtempSync(join(tmpdir(), 'salvia-tui-'));
  resetConfigCache();
});

// Rows: 0-2 input box, 3 "结果" rule, list from row 4.
const LIST_TOP = 4;

describe('mouse input parsing', () => {
  it('splits SGR reports from keys, across chunks', () => {
    const a = splitMouse('ab\u001b[<0;10;5Mc\u001b[<64;3');
    expect(a.text).toBe('abc');
    expect(a.events).toEqual([{ x: 9, y: 4, kind: 'down', button: 'left', shift: false, alt: false, ctrl: false }]);
    const b = splitMouse(';4M\u001b[<35;7;8M', a.pending);
    expect(b.events.map((e) => e.kind)).toEqual(['wheel-up', 'move']);
    expect(splitMouse('\u001b').text).toBe('\u001b'); // a lone Esc key is not held back
  });
});

describe('TUI', { timeout: 30_000 }, () => {
  it('home: layout, examples, and @ completion with Tab', async () => {
    const { stdin, frame, see, unmount } = setup();
    await see('@music <歌名>');
    expect(frame()).toContain('结果');
    expect(frame()).toContain('任务');
    expect(frame()).toContain('鼠标可点击');
    stdin.write('@mu');
    await see('@music:qq-music');
    expect(frame()).toContain('补全');
    stdin.write('\t');
    await see('› @music ');
    stdin.write('晴天');
    await see('› @music 晴天');
    unmount();
  });

  it('unavailable results are hidden until toggled; picking one asks to log in', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, frame, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@music 晴天');
    await see('› @music 晴天');
    stdin.write(ENTER);
    await see('已隐藏 1 个需登录的结果');
    expect(frame()).not.toContain('会员专享');
    expect(frame()).toContain('显示不可用 1');
    stdin.write('\u0014'); // Ctrl+T
    await see('会员专享 · 4K');
    expect(frame()).toContain('隐藏不可用 1');
    for (let i = 0; i < 4; i++) stdin.write(DOWN);
    await see(/\[\*\] 会员专享 · 4K/);
    stdin.write(ENTER);
    await see('需要登录');
    // The dialog takes the list's place instead of floating over it.
    expect(frame()).not.toContain('1080p · mp4');
    stdin.write(RIGHT); // "粘贴 Cookie" ("浏览器登录" would open a real browser)
    await see('[ 粘贴 Cookie ]');
    await wait(20);
    stdin.write(ENTER);
    await see('› @cookie bilibili ');
    unmount();
  });

  it('search → pick with the mouse → download screen → back home when done', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, frame, click, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@music 晴天');
    await see('› @music 晴天');
    stdin.write(ENTER);
    await see('仅音频 · m4a');
    // Third row is "仅音频 · m4a" (4 MB, quick in the demo).
    click(5, LIST_TOP + 2);
    await see('[ 暂停 ]');
    expect(frame()).not.toContain('1080p · mp4'); // single-threaded: results are gone while downloading
    await see('demo/');
    expect(frame()).toContain('✓');
    await see('@music <歌名>'); // back on the home screen
    unmount();
  });

  it('a finished download can be removed from the task area', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@music 晴天');
    stdin.write(ENTER);
    await see('仅音频 · m4a');
    stdin.write(DOWN);
    stdin.write(DOWN); // 仅音频 · m4a, quick in the demo
    await see(/\[\*\] 仅音频 · m4a/);
    stdin.write(ENTER);
    await see('最近 1 个');
    stdin.write(TAB); // input → examples
    stdin.write(TAB); // → task area
    await see('回到输入框');
    stdin.write(ENTER);
    await see('删除下载记录');
    await see('[ 删除记录和文件 ]');
    stdin.write(ENTER); // 删除记录
    await see('没有下载记录');
    unmount();
  });

  it('Esc goes back one level; keyboard Enter activates', async () => {
    const session = new Session(new TaskQueue());
    const handler: Handler = {
      id: 'nav',
      kinds: ['novel-search'],
      async handle(ctx) {
        ctx.status('书', 'idle');
        ctx.items([
          { id: 'a', title: '第一本', pick: () => ctx.items([{ id: 'x', title: '下载 EPUB' }]) },
          { id: 'b', title: '第二本' },
        ]);
      },
    };
    session.register(handler);
    const { stdin, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@novel 书');
    stdin.write(ENTER);
    await see('[*] 第一本');
    stdin.write(ENTER); // activates the selected first row
    await see('下载 EPUB');
    await see('返回上一级');
    stdin.write(ESC);
    await see('第二本');
    unmount();
  });

  it('Esc while downloading asks before cancelling', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, see, gone, unmount } = setup(session);
    await see('结果');
    stdin.write('@music x');
    stdin.write(ENTER);
    await see('[*] 1080p · mp4');
    stdin.write(ENTER); // 1080p, long enough to cancel
    await see('[ 暂停 ]');
    stdin.write(ESC);
    await see('取消下载？');
    stdin.write(LEFT); // focus "取消下载"
    await wait(20);
    stdin.write(ENTER);
    await see('已取消');
    await gone('取消下载？');
    unmount();
  });

  it('a pasted line ending in Enter, in one chunk, submits; Ctrl+U clears', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, frame, see, unmount } = setup(session);
    await see('结果');
    stdin.write('junk');
    await see('› junk');
    stdin.write('\u0015@music 晴天\r');
    await see('1080p · mp4');
    expect(frame()).toContain('› @music 晴天');
    expect(frame()).not.toContain('junk');
    unmount();
  });

  it('Enter opens a result details above its download options; Esc goes back', async () => {
    const session = new Session(new TaskQueue());
    session.register({
      id: 'p',
      kinds: ['novel-search'],
      async handle(ctx) {
        ctx.status('书', 'idle');
        ctx.items([
          {
            id: 'a',
            title: '第一本',
            previewer: async () => ({
              title: '第一本',
              subtitle: '某作者',
              fields: [{ label: '字数', value: '12万' }],
              sections: [
                { title: '简介', text: '一段简介' },
                { title: '第一章', text: '正文开头' },
              ],
            }),
          },
        ]);
      },
    });
    const { stdin, frame, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@novel 书');
    stdin.write(ENTER);
    await see('[*] 第一本');
    stdin.write(ENTER); // a result with details opens them
    await see('一段简介');
    expect(frame()).toContain('详情');
    expect(frame()).toContain('[ ESC 返回 ]');
    expect(frame()).toContain('字数 12万');
    stdin.write(RIGHT);
    await see('正文开头');
    stdin.write(ESC);
    await see('[*] 第一本');
    unmount();
  });

  it('argument completion: values listed, ghost text, → accepts', async () => {
    const { stdin, see, unmount } = setup();
    await see('结果');
    stdin.write('@login sp');
    await see(/› @login spotify\s/); // the list row, and the dimmed rest in the input
    stdin.write(RIGHT);
    await see('› @login spotify ');
    stdin.write('x');
    await see('› @login spotify x');
    stdin.write('\u0015@music:qq');
    await see('@music:qq-music');
    stdin.write(ENTER); // fills, not runs: a keyword still has to follow
    await see('输入歌名');
    unmount();
  });

  it('emptying the input goes back to the home screen', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, see, gone, unmount } = setup(session);
    await see('结果');
    stdin.write('@music a');
    stdin.write(ENTER);
    await see('1080p · mp4');
    stdin.write('\u0015'); // Ctrl+U clears the box
    await see('@music <歌名>');
    await gone('1080p · mp4');
    unmount();
  });

  it('arrow keys move through results', async () => {
    const session = new Session(new TaskQueue()).register(demoHandler);
    const { stdin, see, unmount } = setup(session);
    await see('结果');
    stdin.write('@music a');
    stdin.write(ENTER);
    await see('[*] 1080p · mp4');
    stdin.write(DOWN);
    await see(/\[\*\] 720p · mp4/);
    unmount();
  });
});
