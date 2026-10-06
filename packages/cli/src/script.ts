import type { Item, Session, Task, View } from '@salvia/core';
import { formatSpeed } from './format.ts';

export interface ScriptOptions {
  pick: string[];
  json: boolean;
  /** Also list results that need login (hidden by default, like in the UIs). */
  all?: boolean;
}

/** Rows as listed (and numbered) for the user: locked ones only with --all. */
function visible(items: Item[], all = false): Item[] {
  return all ? items : items.filter((i) => !i.locked);
}

/**
 * Non-interactive run: same intent routing as the UIs, picks chosen by `--pick`,
 * progress on stderr, results on stdout. Exit code 0 on success, 1 on any failure.
 */
export async function runScript(session: Session, text: string, opts: ScriptOptions): Promise<number> {
  await session.input(text);
  let view = session.view();
  if (failed(view)) return report(view, opts, 1);

  const before = new Set(session.queue.list().map((t) => t.id));
  for (const choice of opts.pick) {
    const item = choosePick(visible(view.items, opts.all), choice);
    if (!item) {
      process.stderr.write(`没有匹配 --pick ${choice} 的选项\n`);
      return report(view, opts, 1);
    }
    await session.pick(item.id);
    view = session.view();
    if (failed(view)) return report(view, opts, 1);
  }

  const mine = () => session.queue.list().filter((t) => !before.has(t.id));
  if (!mine().length) return report(session.view(), opts, 0);

  const tasks = await waitTasks(session, mine, opts.json);
  const ok = tasks.every((t) => t.status === 'done');
  if (opts.json) process.stdout.write(`${JSON.stringify({ ...session.view(), tasks }, null, 2)}\n`);
  else
    for (const t of tasks)
      if (t.status === 'done') process.stdout.write(`${t.outputPath ?? t.title}\n`);
      else process.stderr.write(`✗ ${t.title}: ${t.error ?? t.status}\n`);
  return ok ? 0 : 1;
}

export function choosePick(items: Item[], choice: string): Item | undefined {
  const enabled = items.filter((i) => !i.disabled && !i.locked);
  if (choice === 'best') return enabled[0];
  if (choice === 'audio') return enabled.find((i) => /音频|audio/i.test(i.title));
  if (/^\d+$/.test(choice)) {
    const item = items[Number(choice) - 1];
    return item && !item.disabled && !item.locked ? item : undefined;
  }
  return enabled.find((i) => i.id === choice) ?? enabled.find((i) => i.title.toLowerCase().includes(choice.toLowerCase()));
}

function failed(view: View): boolean {
  return view.status.tone === 'error';
}

function report(view: View, opts: ScriptOptions, code: number): number {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return code;
  }
  if (view.status.text) (code ? process.stderr : process.stdout).write(`${view.status.text}\n`);
  const rows = visible(view.items, opts.all);
  rows.forEach((it, i) => {
    const meta = it.meta ? `  ${it.meta}` : '';
    const tag = it.locked ? '(需登录) ' : it.disabled ? '(不可用) ' : '';
    process.stdout.write(`${String(i + 1).padStart(3)}  ${tag}${it.title}${meta}\n`);
  });
  const hidden = view.items.length - rows.length;
  if (hidden) process.stderr.write(`已隐藏 ${hidden} 个需登录的结果（加 --all 显示）\n`);
  return code;
}

const FINAL = new Set<Task['status']>(['done', 'error', 'canceled']);

function waitTasks(session: Session, mine: () => Task[], quiet: boolean): Promise<Task[]> {
  return new Promise((resolve) => {
    const tty = process.stderr.isTTY && !quiet;
    const tick = () => {
      const tasks = mine();
      if (tty) {
        const line = tasks
          .filter((t) => t.status === 'running')
          .map((t) => `${Math.round(Math.max(0, t.progress) * 100)}%${t.speed ? ` ${formatSpeed(t.speed)}` : ''}`)
          .join('  ');
        process.stderr.write(`\r\x1b[2K${line}`);
      }
      if (tasks.every((t) => FINAL.has(t.status))) {
        if (tty) process.stderr.write('\r\x1b[2K');
        session.queue.off('change', tick);
        resolve(tasks);
      }
    };
    session.queue.on('change', tick);
    tick();
  });
}
