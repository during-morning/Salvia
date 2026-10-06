import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { render } from 'ink';
import { explainError, loginSites, type Context, type Session } from '@salvia/core';
import { createSession, prewarm } from '@salvia/app';
import { startServer } from '@salvia/server';
import { App } from './tui/App.tsx';
import { HitProvider, HitRegistry } from './tui/hit.tsx';
import { MOUSE_OFF, MOUSE_ON, MouseStdin } from './tui/mouse.ts';
import { ScreenSelection } from './tui/select.ts';
import { runScript } from './script.ts';
import { QUIT, consoleFilter, serverMode, startServerMode } from './server-mode.ts';

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // no browser available; the URL is printed anyway
  }
}

const WEB_PORT = 8080;

/**
 * `@web [端口]`: the web UI on the same session as the terminal it was typed in (a download started
 * in the browser shows up in the TUI too). Typed again, it just reports the address.
 * `@web:server [端口]` (or `@web server …`): serve other devices instead (see server-mode.ts);
 * `@web:server quit` stops that.
 */
function registerWeb(session: Session): void {
  let running: string | undefined;
  const parsePort = (port: string | undefined) => {
    const n = port ? Number(port) : WEB_PORT;
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  };
  const failed = (err: unknown, n: number, cmd: string) => {
    const inUse = (err as { code?: string }).code === 'EADDRINUSE';
    return inUse ? `端口 ${n} 已被占用，换一个：${cmd} ${n === WEB_PORT ? 2322 : WEB_PORT}` : explainError(err);
  };
  const server = async ([arg]: string[], ctx: Context) => {
    const mode = serverMode();
    if (arg && /^(quit|exit|stop)$/i.test(arg)) {
      if (!mode) return ctx.status('服务端模式没有在运行。', 'idle');
      await mode.stop();
      return ctx.status('已退出服务端模式，可以继续搜索了。', 'ok');
    }
    if (mode) return ctx.status(`服务端已在运行：${mode.urls[0]}（@web:server quit 退出）`, 'ok');
    const n = parsePort(arg);
    if (!n) return ctx.status('端口要是 1–65535 之间的数字，例如 @web:server 8080', 'error');
    if (running?.endsWith(`:${n}`)) return ctx.status(`端口 ${n} 正被网页版使用，换一个端口：@web:server ${n === WEB_PORT ? 2322 : WEB_PORT}`, 'error');
    ctx.status(`正在启动服务端（端口 ${n}）`);
    try {
      const started = await startServerMode(session, n);
      ctx.status(`服务端已启动：${started.urls[0]}`, 'ok');
    } catch (err) {
      ctx.status(failed(err, n, '@web:server'), 'error');
    }
  };
  session.registerCommand({
    name: 'web',
    usage: `@web [端口]（打开网页版，默认端口 ${WEB_PORT}）`,
    bare: true,
    complete: (args) => (args.length === 1 ? [{ value: 'server', meta: '服务端模式：让其他设备访问' }, { value: '', meta: `可选：端口号，默认 ${WEB_PORT}；回车打开网页版` }] : []),
    async run([port, ...rest], ctx) {
      if (port === 'server') return server(rest, ctx);
      if (running) {
        openBrowser(running);
        return ctx.status(`网页版已在运行：${running}（已在浏览器中打开）`, 'ok');
      }
      const n = parsePort(port);
      if (!n) return ctx.status('端口要是 1–65535 之间的数字，例如 @web 2322', 'error');
      ctx.status(`正在启动网页版（端口 ${n}）`);
      try {
        const { address } = await startServer(session, { port: n });
        running = address;
        openBrowser(address);
        ctx.status(`网页版已启动：${address}，和这里共用同一个会话`, 'ok');
      } catch (err) {
        ctx.status(failed(err, n, '@web'), 'error');
      }
    },
  });
  session.registerCommand({
    name: 'web:server',
    usage: `@web:server [端口|quit]（服务端模式：局域网 / 其他设备访问，默认端口 ${WEB_PORT}）`,
    bare: true,
    complete: (args) =>
      args.length === 1
        ? serverMode()
          ? [{ value: 'quit', meta: '退出服务端模式' }]
          : [{ value: '', meta: `可选：端口号，默认 ${WEB_PORT}。网页端每个浏览器独立会话、自动限流，不能登录或改设置` }]
        : [],
    run: (args, ctx) => server(args, ctx),
  });
}

/**
 * `salvia @web:server [端口]`: serve without the TUI. The console takes only `@login <网站>` and
 * `@web:server quit`; activity is printed as it happens.
 */
async function serveConsole(port: number): Promise<void> {
  const session = createSession();
  prewarm();
  let mode;
  try {
    mode = await startServerMode(session, port);
  } catch (err) {
    const inUse = (err as { code?: string }).code === 'EADDRINUSE';
    console.error(inUse ? `端口 ${port} 已被占用，可以换一个：salvia @web:server <端口>` : explainError(err));
    process.exit(1);
  }
  console.log(`Salvia 服务端已启动：\n${mode.urls.map((u) => `  ${u}`).join('\n')}`);
  console.log('网页端每个浏览器独立会话，自动限流，不能登录或修改设置。');
  console.log(`控制台可用：@login <${[...loginSites().keys()].join('|')}>，@web:server quit（退出）`);
  let seen = 0;
  mode.stats.on('change', () => {
    const fresh = mode.stats.log.filter((l) => l.at > seen).reverse();
    for (const l of fresh) console.log(`${new Date(l.at).toTimeString().slice(0, 8)}  ${l.ip.replace(/^::ffff:/, '').padEnd(15)}  ${l.text}`);
    if (fresh.length) seen = fresh[fresh.length - 1]!.at;
  });
  let last = '';
  session.on('view', (v) => {
    const line = v.status.text;
    if (line && line !== last && v.status.tone !== 'busy') console.log(`  ${line}`);
    last = line;
  });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (raw) => {
    const text = raw.trim();
    if (!text) return;
    if (QUIT.test(text)) {
      await mode.stop();
      console.log('已退出服务端模式。');
      process.exit(0);
    }
    const refused = consoleFilter(text);
    if (refused) return console.log(`  ${refused}`);
    await session.input(text);
  });
}

/** `salvia web` and `salvia @web [端口]`: serve until Ctrl+C. */
async function serveWeb(port: number, open: boolean): Promise<void> {
  try {
    const session = createSession();
    prewarm();
    const { address } = await startServer(session, { port });
    console.log(`Salvia 网页版：${address}（Ctrl+C 退出）`);
    if (open) openBrowser(address);
  } catch (err) {
    const inUse = (err as { code?: string }).code === 'EADDRINUSE';
    console.error(inUse ? `端口 ${port} 已被占用，可以换一个：salvia @web <端口>` : explainError(err));
    process.exit(1);
  }
}

/** Full-screen interactive mode with mouse support. */
async function runTui(session: Session): Promise<void> {
  registerWeb(session);
  prewarm();
  const registry = new HitRegistry();
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const stdin = tty ? new MouseStdin(process.stdin, (e) => registry.dispatch(e)) : process.stdin;
  const mouseOff = () => tty && process.stdout.write(MOUSE_OFF);
  process.on('exit', mouseOff);
  // On resize the terminal re-wraps the old frame, and Ink only erases the lines it remembers.
  // Clear the whole screen first (this listener runs before Ink's) so the new frame starts clean.
  let app: ReturnType<typeof render> | undefined;
  const onResize = () => {
    process.stdout.write('\u001b[H\u001b[2J');
    app?.clear();
  };
  if (tty) process.stdout.on('resize', onResize);
  const tree = (
    <HitProvider registry={registry}>
      <App session={session} />
    </HitProvider>
  );
  // Drag to select text, release to copy (Salvia has the mouse, so the terminal's own can't).
  if (tty) registry.drag = new ScreenSelection(process.stdout);
  app = render(tree, { stdin: stdin as NodeJS.ReadStream, exitOnCtrlC: true, alternateScreen: true });
  if (tty) process.stdout.write(MOUSE_ON);
  try {
    await app.waitUntilExit();
  } finally {
    process.stdout.off('resize', onResize);
    mouseOff();
  }
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name('salvia')
    .description('@novel / @music / @video <关键词> 搜索（@music:qq-music 指定平台），@parse <链接或编号> 解析。不带参数进入交互模式；salvia web 打开网页版。')
    .argument('[text...]', '@novel|@music|@video 关键词、@parse 链接或编号，或其他 @命令')
    .option('-p, --pick <choice...>', '自动选择：best | audio | mp3 | 序号 | 文字', [])
    .option('--json', '输出 JSON')
    .option('--all', '同时列出需要登录才能获取的结果')
    .option('--demo', '使用演示数据')
    .action(async (words: string[], opts: { pick: string[]; json?: boolean; all?: boolean; demo?: boolean }) => {
      if (opts.demo) process.env.SALVIA_DEMO = '1';
      const text = words.join(' ').trim();
      // `salvia @web:server [端口]`: server mode without the TUI.
      const srv = text.match(/^@web(?::server|\s+server)(?:\s+(\d+))?$/);
      if (srv) return serveConsole(srv[1] ? Number(srv[1]) : WEB_PORT);
      // `salvia @web [端口]` keeps serving, like `salvia web`.
      const web = text.match(/^@web(?:\s+(\d+))?$/);
      if (web) return serveWeb(web[1] ? Number(web[1]) : WEB_PORT, true);
      const session = createSession();
      if (!text) {
        await runTui(session);
        process.exit(0);
      }
      const code = await runScript(session, text, { pick: opts.pick, json: Boolean(opts.json), all: Boolean(opts.all) });
      process.exit(code);
    });

  program
    .command('web')
    .description('启动本地网页版并打开浏览器')
    .option('--port <port>', '端口', String(WEB_PORT))
    .option('--no-open', '不自动打开浏览器')
    .option('--demo', '使用演示数据')
    .action(async (opts: { port: string; open: boolean; demo?: boolean }) => {
      if (opts.demo) process.env.SALVIA_DEMO = '1';
      await serveWeb(Number(opts.port), opts.open);
    });

  await program.parseAsync(argv);
}
