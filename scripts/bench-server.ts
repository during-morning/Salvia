// Web server load: a 500-row result list, one download reporting progress, N browsers on /api/events.
//   npx tsx scripts/bench-server.ts [clients=5] [seconds=5]
// Prints bytes and events per client per second, and the server's CPU time.
import { Session, TaskQueue } from '@salvia/core';
import { startServer } from '@salvia/server';

const clients = Number(process.argv[2] ?? 5);
const seconds = Number(process.argv[3] ?? 5);

const session = new Session(new TaskQueue());
session.register({
  id: 'bench',
  kinds: ['novel-search'],
  async handle(ctx) {
    ctx.status('500 条', 'idle');
    ctx.items(
      Array.from({ length: 500 }, (_, i) => ({
        id: `r:${i}`,
        title: `[字幕组] 某部动画 第${i}话 1080p 简繁内封 WebRip HEVC-10bit AAC`,
        meta: `字幕组 · 第 ${i} · 1080p · ${700 + i} MB · 动漫花园`,
        cells: [`[字幕组] 某部动画 第${i}话`, '字幕组', String(i), '1080p', '简繁', `${700 + i} MB`, '10-05', '动漫花园'],
        selectable: true,
      })),
    );
  },
});
await session.input('@novel bench');

const { app, address } = await startServer(session, { port: 0 });

let received = 0;
let events = 0;
const controllers: AbortController[] = [];
for (let i = 0; i < clients; i++) {
  const ctl = new AbortController();
  controllers.push(ctl);
  void fetch(`${address}/api/events`, { signal: ctl.signal, headers: { 'accept-encoding': 'identity' } }).then(async (res) => {
    const reader = res.body!.getReader();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      received += value!.length;
      events += (new TextDecoder().decode(value).match(/\n\n/g) ?? []).length;
    }
  });
}
await new Promise((r) => setTimeout(r, 500));
const base = { received, events };

// A download reporting progress every 10 ms (as the segmented downloader does under load).
const started = process.cpuUsage();
session.queue.add({
  kind: 'x',
  title: 'bench',
  run: (signal, report) =>
    new Promise((resolve) => {
      let p = 0;
      const t = setInterval(() => {
        report({ progress: (p = (p + 0.001) % 1), speed: 5e6 });
        if (signal.aborted) clearInterval(t);
      }, 10);
      setTimeout(() => (clearInterval(t), resolve('/tmp/x')), seconds * 1000);
    }),
});
await new Promise((r) => setTimeout(r, seconds * 1000));
const cpu = process.cpuUsage(started);
const bytes = received - base.received;
const ev = events - base.events;
console.log(`${clients} clients, ${seconds}s, 500-row list + 1 download`);
console.log(`  per client: ${(bytes / clients / seconds / 1024).toFixed(1)} KB/s, ${(ev / clients / seconds).toFixed(1)} events/s`);
console.log(`  server CPU: ${((cpu.user + cpu.system) / 1000 / seconds).toFixed(0)} ms per second`);
for (const c of controllers) c.abort();
await app.close();
process.exit(0);
