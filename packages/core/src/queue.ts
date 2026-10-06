import { EventEmitter } from 'node:events';
import { explainError } from './errors.ts';
import type { Progress, Task } from './types.ts';

export interface Job {
  kind: string;
  title: string;
  /** Used for per-host concurrency limits. */
  host?: string;
  /**
   * Does the work. Must honour `signal`. Called again after pause/resume or retry,
   * so it should resume from partial output where it can. Resolves to the output path.
   */
  run(signal: AbortSignal, report: (p: Progress) => void): Promise<string>;
}

export interface QueueOptions {
  concurrency?: number;
  perHost?: number;
  retries?: number;
  /** Base backoff in ms; attempt n waits base * 2^(n-1). */
  backoff?: number;
}

interface Entry {
  task: Task;
  job: Job;
  controller?: AbortController;
  attempts: number;
  timer?: NodeJS.Timeout;
}

let seq = 0;

/** Task queue with global and per-host limits, pause/resume/cancel and exponential-backoff retries. */
export class TaskQueue extends EventEmitter<{ change: [Task] }> {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private concurrency: number;
  private readonly perHost: number;
  private readonly retries: number;
  private readonly backoff: number;

  constructor(opts: QueueOptions = {}) {
    super();
    this.concurrency = opts.concurrency ?? 3;
    this.perHost = opts.perHost ?? 2;
    this.retries = opts.retries ?? 2;
    this.backoff = opts.backoff ?? 1000;
  }

  /** Change how many tasks run at once (@setting concurrency). */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    this.pump();
  }

  add(job: Job): Task {
    const id = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
    const task: Task = { id, kind: job.kind, title: job.title, status: 'queued', progress: 0 };
    this.entries.set(id, { task, job, attempts: 0 });
    this.order.push(id);
    this.emit('change', task);
    this.pump();
    return task;
  }

  list(): Task[] {
    return this.order.map((id) => this.entries.get(id)!.task);
  }

  get(id: string): Task | undefined {
    return this.entries.get(id)?.task;
  }

  pause(id: string): void {
    const e = this.entries.get(id);
    if (!e || (e.task.status !== 'running' && e.task.status !== 'queued')) return;
    this.update(e, { status: 'paused', speed: undefined });
    e.controller?.abort();
  }

  resume(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.task.status !== 'paused') return;
    this.update(e, { status: 'queued' });
    this.pump();
  }

  /** Pause a running/queued task, resume a paused one. */
  toggle(id: string): void {
    const s = this.entries.get(id)?.task.status;
    if (s === 'paused') this.resume(id);
    else this.pause(id);
  }

  cancel(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.task.status === 'done' || e.task.status === 'canceled') return;
    clearTimeout(e.timer);
    this.update(e, { status: 'canceled', speed: undefined });
    e.controller?.abort();
  }

  /** Stop a task if it is still going and forget it. */
  remove(id: string): Task | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.cancel(id);
    this.entries.delete(id);
    this.order = this.order.filter((o) => o !== id);
    this.emit('change', e.task);
    return e.task;
  }

  /** Forget finished tasks. */
  clearFinished(): void {
    this.order = this.order.filter((id) => {
      const s = this.entries.get(id)!.task.status;
      const keep = s !== 'done' && s !== 'canceled' && s !== 'error';
      if (!keep) this.entries.delete(id);
      return keep;
    });
  }

  private running(): Entry[] {
    return [...this.entries.values()].filter((e) => e.task.status === 'running');
  }

  private pump(): void {
    const running = this.running();
    for (const id of this.order) {
      if (running.length >= this.concurrency) return;
      const e = this.entries.get(id)!;
      if (e.task.status !== 'queued' || e.timer) continue;
      const host = e.job.host;
      if (host && running.filter((r) => r.job.host === host).length >= this.perHost) continue;
      running.push(e);
      void this.start(e);
    }
  }

  private async start(e: Entry): Promise<void> {
    const controller = new AbortController();
    e.controller = controller;
    e.attempts++;
    this.update(e, { status: 'running', error: undefined });
    try {
      const out = await e.job.run(controller.signal, (p) => {
        if (e.task.status === 'running') this.update(e, { progress: p.progress, speed: p.speed });
      });
      if (controller.signal.aborted) return;
      this.update(e, { status: 'done', progress: 1, speed: undefined, outputPath: out });
    } catch (err) {
      if (controller.signal.aborted) return; // paused or canceled; status already set
      const message = explainError(err);
      if (e.attempts <= this.retries && !isFatal(err)) {
        this.update(e, { status: 'queued', speed: undefined, error: message });
        const wait = this.backoff * 2 ** (e.attempts - 1);
        e.timer = setTimeout(() => {
          e.timer = undefined;
          this.pump();
        }, wait);
      } else {
        this.update(e, { status: 'error', speed: undefined, error: message });
      }
    } finally {
      if (e.controller === controller) e.controller = undefined;
      this.pump();
    }
  }

  private update(e: Entry, patch: Partial<Task>): void {
    Object.assign(e.task, patch);
    this.emit('change', e.task);
  }
}

/** Errors that retrying cannot fix (bad input, no permission). */
export class FatalError extends Error {
  override name = 'FatalError';
}

function isFatal(err: unknown): boolean {
  return err instanceof FatalError;
}
