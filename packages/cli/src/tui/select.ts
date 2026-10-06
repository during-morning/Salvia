import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import xtermHeadless, { type IBufferCell } from '@xterm/headless';

/**
 * Text selection for the full-screen TUI. Salvia takes the mouse (clicks, hover, wheel), so the
 * terminal's own drag-to-select doesn't work; this brings it back: drag over the screen to select,
 * release to copy (OSC 52, understood by Windows Terminal, iTerm2, kitty …, and the system
 * clipboard command as well).
 *
 * The screen is known exactly by mirroring everything written to the terminal into a headless
 * terminal emulator. While a selection is shown, Ink's frames are held until the mirror has them
 * and go out in one write together with the highlight, so the terminal never shows a frame
 * without it (that was a flicker on every redraw).
 */

const { Terminal } = xtermHeadless;

export const selectionEvents = new EventEmitter<{ copied: [chars: number] }>();

type Point = { x: number; y: number };

/** DEC synchronized output: the terminal shows what is between these at once. */
const SYNC_ON = '\u001b[?2026h';
const SYNC_OFF = '\u001b[?2026l';

const rgb = (v: number) => `${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;

/** The SGR sequence for a cell's colours and attributes. */
function sgr(c: IBufferCell): string {
  const p = ['0'];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isInverse()) p.push('7');
  if (c.isStrikethrough()) p.push('9');
  if (c.isFgRGB()) p.push(`38;2;${rgb(c.getFgColor())}`);
  else if (c.isFgPalette()) p.push(`38;5;${c.getFgColor()}`);
  if (c.isBgRGB()) p.push(`48;2;${rgb(c.getBgColor())}`);
  else if (c.isBgPalette()) p.push(`48;5;${c.getBgColor()}`);
  return `\u001b[${p.join(';')}m`;
}

export class ScreenSelection {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly write: (chunk: unknown, ...rest: unknown[]) => boolean;
  private anchor?: Point;
  private head?: Point;
  /** Rows painted inverse last time, to restore. */
  private painted = new Set<number>();
  private repaintQueued = false;
  /** Frames held for the mirror; later writes queue behind them so the order stays. */
  private held = 0;
  private painting = false;

  constructor(private readonly out: NodeJS.WriteStream) {
    // convertEol: the tty turns Ink's bare line feeds into CR LF on the way to the real terminal.
    this.term = new Terminal({ cols: out.columns || 80, rows: out.rows || 24, allowProposedApi: true, scrollback: 0, convertEol: true });
    // Everything written to the terminal also goes to the mirror.
    this.write = out.write.bind(out) as (chunk: unknown, ...rest: unknown[]) => boolean;
    out.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (this.painting || !(typeof chunk === 'string' || chunk instanceof Uint8Array)) return this.write(chunk, ...rest);
      if (!this.shown && !this.held) {
        this.term.write(chunk);
        return this.write(chunk, ...rest);
      }
      // A selection is shown: the frame goes out once the mirror has it, highlight included.
      this.held++;
      this.term.write(chunk, () => {
        this.held--;
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        this.emit(text + (this.shown ? this.overlay() : ''), ...rest);
      });
      return true;
    }) as typeof out.write;
    out.on('resize', () => {
      this.term.resize(out.columns || 80, out.rows || 24);
      // The screen is cleared and redrawn on resize; nothing to restore.
      this.painted.clear();
      this.clear();
    });
  }

  get active(): boolean {
    return !!this.anchor;
  }

  private get shown(): boolean {
    return !!(this.anchor && this.head);
  }

  start(p: Point): void {
    this.clear();
    this.anchor = p;
    this.head = p;
    this.queueRepaint();
  }

  move(p: Point): void {
    if (!this.anchor) return;
    this.head = p;
    this.queueRepaint();
  }

  /** Release: copy what is selected (once the mirror is current); the highlight stays until the next click. */
  end(p: Point): void {
    if (!this.anchor) return;
    this.head = p;
    this.term.write('', () => {
      if (!this.shown) return;
      this.emit(this.overlay());
      const text = this.text();
      if (text) {
        copy(this.out, text);
        selectionEvents.emit('copied', [...text].length);
      }
    });
  }

  /** Drop the selection: the rows it covered get their own text and colours back. */
  clear(): void {
    this.anchor = undefined;
    this.head = undefined;
    if (!this.painted.size) return;
    const rows = [...this.painted];
    this.painted.clear();
    // After any frame still held, so the rows are restored from the screen as it now is.
    this.term.write('', () => {
      if (this.shown) return;
      this.emit(rows.map((y) => this.restore(y)).join('') + this.cursor());
    });
  }

  /** Start and end in reading order, the end inclusive. */
  private range(): [Point, Point] | undefined {
    if (!this.anchor || !this.head) return undefined;
    const [a, b] = [this.anchor, this.head];
    return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  }

  /** The cells of row `y` from column `x0` to `x1` (inclusive), wide characters whole; `styled` keeps their colours. */
  private cells(y: number, x0: number, x1: number, styled = false): { text: string; from: number; to: number } {
    const line = this.term.buffer.active.getLine(y);
    if (!line) return { text: '', from: x0, to: x0 };
    let from = x0;
    // Starting on the right half of a wide character: take the whole character.
    if (from > 0 && line.getCell(from)?.getWidth() === 0) from--;
    let text = '';
    let style = '';
    let x = from;
    for (; x <= x1 && x < this.term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      if (styled) {
        const s = sgr(cell);
        if (s !== style) text += style = s;
      }
      text += cell.getChars() || ' ';
      if (cell.getWidth() === 2) x++;
    }
    return { text, from, to: x };
  }

  private rows(): { y: number; x0: number; x1: number }[] {
    const r = this.range();
    if (!r) return [];
    const [a, b] = r;
    const out = [];
    for (let y = a.y; y <= b.y; y++) out.push({ y, x0: y === a.y ? a.x : 0, x1: y === b.y ? b.x : this.term.cols - 1 });
    return out;
  }

  /** The selected text: lines joined with newlines, trailing spaces dropped. */
  text(): string {
    return this.rows()
      .map(({ y, x0, x1 }) => this.cells(y, x0, x1).text.replace(/\s+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
  }

  private queueRepaint(): void {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    // After whatever the emulator still has to parse.
    this.term.write('', () => {
      this.repaintQueued = false;
      if (this.shown) this.emit(this.overlay());
    });
  }

  /** Row `y` as the mirror has it, colours included. */
  private restore(y: number): string {
    return `\u001b[${y + 1};1H${this.cells(y, 0, this.term.cols - 1, true).text}\u001b[0m`;
  }

  /** Back to where the mirror says the cursor is. No ESC 7 / ESC 8: Ink keeps its own cursor in that slot. */
  private cursor(): string {
    const buf = this.term.buffer.active;
    return `\u001b[0m\u001b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
  }

  /** The selection drawn inverse over the frame (and rows it no longer covers put back). */
  private overlay(): string {
    const rows = this.rows();
    const now = new Set(rows.map((r) => r.y));
    let seq = '';
    for (const y of this.painted) if (!now.has(y)) seq += this.restore(y);
    for (const { y, x0, x1 } of rows) {
      const c = this.cells(y, x0, x1);
      seq += `\u001b[${y + 1};${c.from + 1}H\u001b[0;7m${c.text}\u001b[27m`;
    }
    this.painted = now;
    return seq + this.cursor();
  }

  /** One write to the real terminal, shown at once, not mirrored (the mirror already has the frame). */
  private emit(seq: string, ...rest: unknown[]): void {
    this.painting = true;
    try {
      this.write(SYNC_ON + seq + SYNC_OFF, ...rest);
    } finally {
      this.painting = false;
    }
  }
}

/** OSC 52 (the terminal's clipboard) and the system clipboard command, best effort. */
function copy(out: NodeJS.WriteStream, text: string): void {
  out.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
  // Tests must not touch the real clipboard.
  if (process.env.VITEST) return;
  const cmd =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]
      : process.platform === 'darwin'
        ? ['pbcopy', []]
        : ['sh', ['-c', 'command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard']];
  try {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    child.stdin.end(text);
  } catch {
    // OSC 52 alone, then
  }
}
