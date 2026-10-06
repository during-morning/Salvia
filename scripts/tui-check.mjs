// Drive the real TUI in a pseudo-terminal and print what a terminal would show.
//   node scripts/tui-check.mjs [cols] [rows]
// Checks layout at a given size, the hardware cursor position while typing CJK text, and mouse
// clicks/wheel sent as real SGR sequences.
import { spawn } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
const cols = Number(process.argv[2] ?? 100);
const rows = Number(process.argv[3] ?? 30);
const term = new Terminal({ cols, rows, allowProposedApi: true });
// Demo data unless DEMO=0 (real sites).
// SALVIA_EXE=dist/salvia.exe checks the packaged build instead of the source.
const demo = process.env.DEMO === '0' ? [] : ['--demo'];
const pty = spawn(process.env.SALVIA_EXE ?? process.execPath, process.env.SALVIA_EXE ? demo : ['packages/cli/bin/salvia.mjs', ...demo], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: process.cwd(),
  env: { ...process.env, SALVIA_HOME: process.env.SALVIA_HOME ?? '', FORCE_COLOR: '1' },
  // The ConPTY that Windows Terminal ships (passes mouse modes through); Windows 10's built-in one doesn't.
  useConptyDll: process.env.SYSTEM_CONPTY ? false : true,
});
let mouseOn = false;
pty.onData((d) => {
  if (d.includes('\u001b[?1006h')) mouseOn = true;
  term.write(d);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => new Promise((r) => term.write('', r));
async function screen(label) {
  await flush();
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  // Cursor visibility: xterm tracks DECTCEM in coreService; fall back to "unknown".
  const hidden = term._core?.coreService?.isCursorHidden;
  console.log(`\n=== ${label}  (cursor x=${buf.cursorX} y=${buf.cursorY}${hidden === undefined ? '' : hidden ? ' hidden' : ' visible'})`);
  console.log(lines.map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n'));
  return { lines, x: buf.cursorX, y: buf.cursorY, hidden };
}
const click = (x, y) => pty.write(`\u001b[<0;${x + 1};${y + 1}M\u001b[<0;${x + 1};${y + 1}m`);
const wheel = (x, y, down) => pty.write(`\u001b[<${down ? 65 : 64};${x + 1};${y + 1}M`);

const steps = process.argv[4] ?? 'all';
// Wait until the first frame is drawn (the newer ConPTY starts slower).
for (let i = 0; i < 100 && !(await screen.quiet?.()); i++) {
  await wait(100);
  await flush();
  if ((term.buffer.active.getLine(0)?.translateToString(true) ?? '').includes('╭')) break;
}
await wait(800);
await screen('home');
console.log('mouse reporting requested:', mouseOn, '· terminal mouse tracking mode:', term.modes.mouseTrackingMode);

pty.write(process.env.INPUT ?? '@music 晴天');
await wait(400);
const typed = await screen('typed CJK text');
const line = typed.lines[typed.y] ?? '';
console.log('cursor cell after text:', JSON.stringify(line.slice(Math.max(0, typed.x - 6), typed.x + 2)));

pty.write('\r');
await wait(Number(process.env.WAIT ?? 7000));
await screen('results');

if (steps === 'dialog') {
  // Show the locked demo result, open it: the login dialog must replace the list, not overlay it.
  pty.write('\u0014');
  await wait(300);
  const shown = await screen('locked shown');
  const row = shown.lines.findIndex((l) => l.includes(process.env.LOCKED ?? '会员专享'));
  click(6, row);
  await wait(500);
  await screen('login dialog');
}

if (steps === 'batch') {
  // Table results: Space checks a row and moves on; Ctrl+A checks all (nothing is downloaded).
  pty.write(' ');
  await wait(150);
  pty.write(' ');
  await wait(300);
  await screen('two checked');
  pty.write('\u0001');
  await wait(300);
  await screen('all checked');
}

if (steps === 'select') {
  // Drag over two result rows: they turn inverse; releasing copies and says so.
  const col = () => (term.buffer.active.getLine(5)?.translateToString(false) ?? '').indexOf('22 MB');
  console.log('"22 MB" column before:', col());
  pty.write(`[<0;3;6M`);
  pty.write(`[<32;12;6M[<32;20;7M`);
  await wait(300);
  const sel = term.buffer.active;
  const inverse = [5, 6].map((y) => sel.getLine(y)?.getCell(4)?.isInverse() ? 'inverse' : 'plain');
  console.log('rows 5-6 while dragging:', inverse.join(', '));
  pty.write(`[<0;20;7m`);
  await wait(800);
  console.log('"22 MB" column after:', col());
  await screen('after release (toast)');
}

if (steps === 'detail') {
  // Enter opens the selected result: details on top, download options below; Esc goes back.
  pty.write('\r');
  await wait(300);
  await screen('detail loading');
  await wait(Number(process.env.PREVIEW_WAIT ?? 5000));
  await screen('detail');
  pty.write('\u001b');
  await wait(600);
  await screen('back to results');
}

if (steps === 'all') {
  wheel(10, 6, true);
  await wait(200);
  await screen('after wheel down');
  // A real download: a YouTube link, then click the "仅音频 · m4a" row.
  pty.write('\u0015https://youtu.be/dQw4w9WgXcQ\r');
  await wait(5000);
  const formats = await screen('formats');
  const row = formats.lines.findIndex((l) => l.includes('仅音频 · m4a'));
  click(6, row);
  await wait(1500);
  await screen('download screen');
  for (let i = 0; i < 60; i++) {
    await wait(500);
    await flush();
    if ((term.buffer.active.getLine(3)?.translateToString(true) ?? '').includes('结果')) break;
  }
  await screen('back home after download');
  pty.resize(60, 16);
  term.resize(60, 16);
  await wait(500);
  console.log('\n(resized to 60x16)');
  const small = term.buffer.active;
  for (let y = 0; y < 16; y++) console.log(`${String(y).padStart(2)}|${small.getLine(y)?.translateToString(true)}`);
}

pty.write('\u0003');
await wait(300);
pty.kill();
process.exit(0);
