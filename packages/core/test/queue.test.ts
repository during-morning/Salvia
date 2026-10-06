import { describe, expect, it } from 'vitest';
import { FatalError, TaskQueue, type Job } from '../src/queue.ts';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function job(over: Partial<Job> = {}): Job {
  return { kind: 'x', title: 'x', run: async () => 'out', ...over };
}

describe('TaskQueue', () => {
  it('respects global and per-host concurrency', async () => {
    const q = new TaskQueue({ concurrency: 2, perHost: 1 });
    const g = gate();
    let active = 0, peak = 0, peakA = 0, activeA = 0;
    const mk = (host: string) =>
      job({
        host,
        async run() {
          active++; peak = Math.max(peak, active);
          if (host === 'a') { activeA++; peakA = Math.max(peakA, activeA); }
          await g.p;
          active--; if (host === 'a') activeA--;
          return 'ok';
        },
      });
    const tasks = [mk('a'), mk('a'), mk('b'), mk('b')].map((j) => q.add(j));
    await tick();
    expect(tasks.map((t) => t.status)).toEqual(['running', 'queued', 'running', 'queued']);
    g.open();
    await tick(20);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(peak).toBe(2);
    expect(peakA).toBe(1);
  });

  it('pause aborts and resume re-runs', async () => {
    const q = new TaskQueue();
    let runs = 0;
    const t = q.add(job({
      run: (signal) => { runs++; return new Promise((res, rej) => {
        if (runs > 1) return res('done');
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      }); },
    }));
    await tick();
    q.pause(t.id);
    await tick();
    expect(t.status).toBe('paused');
    q.resume(t.id);
    await tick();
    expect(t.status).toBe('done');
    expect(runs).toBe(2);
  });

  it('cancel stops a running task', async () => {
    const q = new TaskQueue();
    const t = q.add(job({ run: (s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('x')))) }));
    await tick();
    q.cancel(t.id);
    await tick();
    expect(t.status).toBe('canceled');
  });

  it('retries with backoff, but not fatal errors', async () => {
    const q = new TaskQueue({ retries: 2, backoff: 1 });
    let n = 0;
    const flaky = q.add(job({ async run() { if (++n < 3) throw new Error('flaky'); return 'ok'; } }));
    let m = 0;
    const fatal = q.add(job({ async run() { m++; throw new FatalError('no'); } }));
    await tick(40);
    expect(flaky.status).toBe('done');
    expect(n).toBe(3);
    expect(fatal.status).toBe('error');
    expect(m).toBe(1);
  });
});
