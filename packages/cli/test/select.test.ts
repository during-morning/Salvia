import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { HitRegistry } from '../src/tui/hit.tsx';
import { ScreenSelection, selectionEvents } from '../src/tui/select.ts';

/** A terminal-like stream that keeps what was written. */
function fakeOut(cols = 20, rows = 4) {
  const out = Object.assign(new EventEmitter(), { columns: cols, rows, written: '', write(chunk: string) { out.written += chunk; return true; } });
  return out as unknown as NodeJS.WriteStream & { written: string };
}

const ev = (kind: 'down' | 'move' | 'up', x: number, y: number) => ({ x, y, kind, button: 'left' as const, shift: false, alt: false, ctrl: false });
const flush = () => new Promise((r) => setTimeout(r, 50));

describe('drag to select', () => {
  it('copies the dragged text, wide characters whole, trailing spaces dropped', async () => {
    const out = fakeOut();
    const sel = new ScreenSelection(out);
    out.write('first line\nsecond 晴天 line\nthird');
    await flush();
    let copied = 0;
    selectionEvents.once('copied', (n) => (copied = n));
    sel.start({ x: 6, y: 0 });
    sel.move({ x: 8, y: 1 });
    sel.end({ x: 8, y: 1 });
    await flush();
    expect(sel.text()).toBe('line\nsecond 晴');
    expect(copied).toBe('line\nsecond 晴'.length);
    expect(out.written).toContain('\u001b]52;c;'); // OSC 52 clipboard
  });

  it('a frame drawn while selected goes out in one write with the highlight; clearing restores colours', async () => {
    const E = '\u001b';
    const out = fakeOut();
    const writes: string[] = [];
    const real = out.write.bind(out);
    out.write = ((chunk: string) => (writes.push(chunk), real(chunk))) as typeof out.write;
    const sel = new ScreenSelection(out);
    out.write(`${E}[31mred${E}[0m text`);
    await flush();
    sel.start({ x: 0, y: 0 });
    sel.move({ x: 2, y: 0 });
    await flush();
    writes.length = 0;
    out.write(`${E}[H${E}[31mred${E}[0m TEXT`);
    expect(writes).toEqual([]); // held for the mirror
    await flush();
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.startsWith(`${E}[?2026h${E}[H`)).toBe(true);
    expect(w.endsWith(`${E}[?2026l`)).toBe(true);
    expect(w.indexOf(`${E}[0;7mred`)).toBeGreaterThan(w.indexOf('TEXT'));
    writes.length = 0;
    sel.clear();
    await flush();
    expect(writes.join('')).toContain(`${E}[0;38;5;1mred`); // the row back in its own colour
    writes.length = 0;
    out.write('plain');
    expect(writes).toEqual(['plain']); // nothing selected: straight through
  });

  it('a press that moves selects; one that does not is a click on release', () => {
    const reg = new HitRegistry();
    const calls: string[] = [];
    reg.drag = { start: () => calls.push('start'), move: () => calls.push('move'), end: () => calls.push('end'), clear: () => calls.push('clear') };
    reg.dispatch(ev('down', 1, 1));
    reg.dispatch(ev('up', 1, 1));
    reg.dispatch(ev('down', 1, 1));
    reg.dispatch(ev('move', 4, 1));
    reg.dispatch(ev('up', 4, 1));
    expect(calls).toEqual(['clear', 'clear', 'start', 'move', 'end']);
  });
});
