import { describe, expect, it } from 'vitest';
import { Session, splitArgs } from '../src/session.ts';
import { TaskQueue } from '../src/queue.ts';

describe('Session', () => {
  it('routes to a handler and picks items', async () => {
    const s = new Session(new TaskQueue());
    let picked = '';
    s.register({
      id: 't', kinds: ['novel-search'],
      async handle(ctx) {
        ctx.status('found', 'idle');
        ctx.items([{ id: 'a', title: 'A', pick: () => { picked = 'a'; } }, { id: 'b', title: 'B', disabled: true, pick: () => { picked = 'b'; } }]);
      },
    });
    await s.input('@novel 书名');
    expect(s.view().items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(s.view().items[0]).not.toHaveProperty('pick');
    await s.pick('b');
    expect(picked).toBe('');
    await s.pick('a');
    expect(picked).toBe('a');
  });

  it('reports unsupported intents and handler errors', async () => {
    const s = new Session(new TaskQueue());
    await s.input('https://example.com/x');
    expect(s.view().status.tone).toBe('error');
    s.register({ id: 'boom', kinds: ['novel-search'], handle: async () => { throw new Error('网络错误'); } });
    await s.input('@novel abc');
    expect(s.view().status).toEqual({ text: '网络错误', tone: 'error' });
  });

  it('new input silences the previous search', async () => {
    const s = new Session(new TaskQueue());
    let release!: () => void;
    s.register({
      id: 'slow', kinds: ['novel-search'],
      async handle(ctx) {
        if (ctx.intent.input === 'slow') await new Promise<void>((r) => (release = r));
        ctx.items([{ id: ctx.intent.input, title: ctx.intent.input }]);
      },
    });
    const first = s.input('@novel slow');
    await s.input('@novel fast');
    release();
    await first;
    expect(s.view().items.map((i) => i.id)).toEqual(['fast']);
  });

  it('plain text offers the searches; picking one runs it', async () => {
    const s = new Session(new TaskQueue());
    let searched = '';
    s.register({ id: 'm', kinds: ['music-search'], handle: async (ctx) => void (searched = ctx.intent.input) });
    await s.input('晴天');
    expect(s.view().items.map((i) => i.title)).toEqual(['@novel 晴天', '@music 晴天', '@video 晴天', '@anime 晴天']);
    await s.pick('search:music');
    expect(searched).toBe('晴天');
  });


  it('splitArgs keeps quotes', () => {
    expect(splitArgs('dir "C:/My Files" x')).toEqual(['dir', 'C:/My Files', 'x']);
  });
});


describe('view patches', () => {
  it('emit only the parts that changed, with the list serialised once per change', async () => {
    const s = new Session(new TaskQueue());
    s.register({ id: 't', kinds: ['novel-search'], handle: async (ctx) => ctx.items([{ id: 'a', title: 'A' }]) });
    const patches: string[][] = [];
    s.on('patch', (parts) => patches.push([...parts].sort()));
    await s.input('@novel x');
    await new Promise((r) => setTimeout(r, 80));
    expect(patches.at(-1)).toEqual(['list', 'status']);
    const json = JSON.parse(s.partsJson(['list', 'status']));
    expect(json.list.items).toEqual([{ id: 'a', title: 'A' }]);
    expect(s.partsJson(['list'])).toBe(s.partsJson(['list'])); // cached text

    patches.length = 0;
    s.notify('hi');
    await new Promise((r) => setTimeout(r, 80));
    expect(patches).toEqual([['status']]);
  });

  it('publish running progress at most four times a second', async () => {
    const s = new Session(new TaskQueue());
    let tasks = 0;
    s.on('patch', (parts) => parts.has('tasks') && tasks++);
    s.queue.add({
      kind: 'x',
      title: 'x',
      run: (_signal, report) =>
        new Promise((resolve) => {
          const t = setInterval(() => report({ progress: 0.5 }), 5);
          setTimeout(() => (clearInterval(t), resolve('/tmp/x')), 1000);
        }),
    });
    await new Promise((r) => setTimeout(r, 1200));
    // added + running + ~4 progress updates per second + done
    expect(tasks).toBeGreaterThanOrEqual(3);
    expect(tasks).toBeLessThanOrEqual(9);
  });
});
