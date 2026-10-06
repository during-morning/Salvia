import type { Handler } from './session.ts';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * Stand-in provider for wiring up the UIs before real extractors exist. Enabled with SALVIA_DEMO=1.
 * Every intent resolves to a few fake options; picking one runs a fake download that resumes after pause.
 */
export const demoHandler: Handler = {
  id: 'demo',
  kinds: ['video', 'music', 'music-search', 'novel-search'],
  async handle(ctx) {
    ctx.status('解析中…');
    await sleep(600, ctx.signal);
    const name = ctx.intent.input.slice(0, 40);
    ctx.status(`演示：${name}`, 'idle');
    const options = [
      { label: '1080p · mp4', size: 48 },
      { label: '720p · mp4', size: 22 },
      { label: '仅音频 · m4a', size: 4 },
    ];
    ctx.items([
      ...options.map((o, i) => ({
        id: `demo${i}`,
        title: o.label,
        meta: `${o.size} MB`,
        pick: () => {
          let done = 0;
          ctx.enqueue({
            kind: 'demo',
            title: `${name} · ${o.label}`,
            host: 'demo',
            async run(signal, report) {
              while (done < o.size) {
                await sleep(120, signal);
                done += 1;
                report({ progress: done / o.size, speed: 1024 * 1024 * 8 });
              }
              return `demo/${name}.mp4`;
            },
          });
          ctx.status('已加入下载', 'ok');
        },
      })),
      { id: 'demo-off', title: '会员专享 · 4K', meta: '48 MB', locked: { reason: '需要大会员', site: 'bili' } },
    ]);
  },
};
