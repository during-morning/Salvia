import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

// Node's raw mode on Windows turns on VT input but not ENABLE_MOUSE_INPUT (0x10), so the console
// never reports the mouse even when the terminal (Windows Terminal, VS Code) supports it. Console
// modes are shared by every process attached to the console, so a short PowerShell child sets the
// flag for us; no extra binaries needed. Node restores the console mode itself on exit.
const ENABLE_MOUSE_PS = [
  "$s='[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetStdHandle(int h);",
  '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);',
  "[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);';",
  '$k=Add-Type -MemberDefinition $s -Name SalviaConsole -Namespace Salvia -PassThru;',
  '$h=$k::GetStdHandle(-10); $m=0; [void]$k::GetConsoleMode($h,[ref]$m); [void]$k::SetConsoleMode($h, $m -bor 0x10)',
].join(' ');

function enableWindowsMouseInput(): void {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ENABLE_MOUSE_PS], {
      stdio: ['inherit', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', () => {}); // no PowerShell: keyboard only
  } catch {
    // keyboard only
  }
}

/**
 * Terminal mouse support: SGR (1006) reports are split out of stdin before Ink sees it, and turned
 * into events. Terminals without mouse reporting (old conhost) simply never send any, so the UI
 * keeps working from the keyboard.
 */

export type MouseKind = 'down' | 'up' | 'move' | 'wheel-up' | 'wheel-down';

export interface MouseEvent {
  /** 0-based cell column and row. */
  x: number;
  y: number;
  kind: MouseKind;
  button: 'left' | 'middle' | 'right' | 'none';
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

// 1000: clicks, 1003: any motion (for hover), 1006: SGR encoding (no 223-column limit).
export const MOUSE_ON = '\u001b[?1000h\u001b[?1003h\u001b[?1006h';
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1003l\u001b[?1000l';

const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** An SGR report cut off at the end of a chunk. A lone ESC is left alone: it may be the Esc key. */
const PARTIAL = /\u001b\[<[\d;]*$/;

export function decode(code: number, x: number, y: number, final: string): MouseEvent {
  const base = code & 3;
  const motion = (code & 32) !== 0;
  const wheel = (code & 64) !== 0;
  const mods = { shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0 };
  const pos = { x: x - 1, y: y - 1 };
  if (wheel) return { ...pos, ...mods, kind: base === 0 ? 'wheel-up' : 'wheel-down', button: 'none' };
  const button = (['left', 'middle', 'right', 'none'] as const)[base]!;
  if (motion) return { ...pos, ...mods, kind: 'move', button };
  return { ...pos, ...mods, kind: final === 'M' ? 'down' : 'up', button };
}

/** Split a chunk into keyboard text (for Ink) and mouse events; `pending` carries a cut-off report. */
export function splitMouse(chunk: string, pending = ''): { text: string; events: MouseEvent[]; pending: string } {
  let data = pending + chunk;
  let rest = '';
  const partial = data.match(PARTIAL);
  if (partial) {
    rest = partial[0];
    data = data.slice(0, partial.index);
  }
  const events: MouseEvent[] = [];
  const text = data.replace(SGR, (_, c: string, x: string, y: string, f: string) => {
    events.push(decode(Number(c), Number(x), Number(y), f));
    return '';
  });
  return { text, events, pending: rest };
}

/**
 * Stand-in for process.stdin handed to Ink: same raw-mode TTY, minus the mouse reports.
 */
export class MouseStdin extends PassThrough {
  readonly isTTY = true;
  private pending = '';

  constructor(
    private readonly source: NodeJS.ReadStream,
    private readonly onMouse: (e: MouseEvent) => void,
  ) {
    super();
    source.setEncoding('utf8');
    source.on('data', (chunk: string) => {
      const { text, events, pending } = splitMouse(chunk, this.pending);
      this.pending = pending;
      if (text) this.push(text);
      for (const e of events) this.onMouse(e);
    });
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode?.(enabled);
    if (enabled && process.platform === 'win32') enableWindowsMouseInput();
    return this;
  }

  ref(): this {
    this.source.ref();
    return this;
  }

  unref(): this {
    this.source.unref();
    return this;
  }
}
