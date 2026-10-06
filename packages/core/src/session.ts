import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { loadConfig, type Config } from './config.ts';
import { downloadStore, type DownloadRecord } from './db.ts';
import { settingEvents, settingNumber, uiPrefs } from './settings.ts';
import { explainError } from './errors.ts';
import { SEARCH_TYPES, detectIntent, type SearchType } from './intent.ts';
import { followRedirects } from './links.ts';
import { registry } from './registry.ts';
import { TaskQueue, type Job } from './queue.ts';
import type { AudioClip, Column, Intent, IntentKind, Item, Playback, Preview, Status, Task, Tone, View } from './types.ts';

/** How a list is shown and what checked rows do. */
export interface ListOptions {
  columns?: Column[];
  /** Run on the checked rows' ids (in list order). */
  batch?: { label: string; run: (ids: string[]) => void | Promise<void> };
}

type ListState = { status: Status; items: PickItem[]; columns?: Column[]; batch?: ListOptions['batch'] };

/** A preview plus the clip behind its 试听 button. */
export type PreviewData = Preview & { clip?: AudioClip };

export interface PickItem extends Item {
  pick?: (ctx: Context) => void | Promise<void>;
  /** Details for Session.preview(); sets `preview` on the item. */
  previewer?: (signal: AbortSignal) => Promise<PreviewData>;
}

/** Plays a clip until done or aborted; `onStart` fires when sound begins. Wired by the app (ffmpeg). */
export type Player = (clip: AudioClip, opts: { signal: AbortSignal; onStart: () => void }) => Promise<void>;

export interface Context {
  readonly intent: Intent;
  /** Aborted when the user types something new. Long searches should stop on it. */
  readonly signal: AbortSignal;
  readonly config: Config;
  /** Rows picked since this input began. A streaming search stops redrawing once one is opened. */
  readonly picks: number;
  status(text: string, tone?: Tone): void;
  /** Replace the list (optionally as a table, and with an action for checked rows). */
  items(list: PickItem[], opts?: ListOptions): void;
  /** Append to the list (streaming results). */
  append(list: PickItem[]): void;
  enqueue(job: Job): Task;
  /** Forget finished tasks (@clear). */
  clearFinished(): void;
}

export interface Handler {
  id: string;
  kinds: IntentKind[];
  /** Narrow within a kind, e.g. by `intent.site`. Defaults to accepting everything of its kinds. */
  match?(intent: Intent): boolean;
  handle(ctx: Context): Promise<void>;
}

/** A value a command accepts at the argument being typed. `value: ''` is a hint row (nothing to fill). */
export interface ArgOption {
  value: string;
  meta?: string;
}

export interface Command {
  name: string;
  usage: string;
  run(args: string[], ctx: Context): void | Promise<void>;
  /** Values for the last of `args` (which may be ''), for completion while typing. */
  complete?(args: string[]): ArgOption[];
  /** Arguments are optional: typed in full, Enter runs it instead of completing (@setting, @web). */
  bare?: boolean;
}

/** A completion row: `fill` replaces the input (absent for a hint). */
export interface Completion {
  title: string;
  meta?: string;
  fill?: string;
  /** What is typed already is this completion in full and runs as is (Enter runs instead of filling). */
  ready?: boolean;
}

const IDLE: Status = { text: '', tone: 'idle' };

/**
 * The single entry point for both UIs: text goes in through `input`, a row is chosen with `pick`,
 * and the whole view is re-emitted on every change.
 */
/** The parts of a View that change independently (see Session `patch`). */
export type ViewPart = 'list' | 'status' | 'tasks' | 'playback' | 'prefs';
const ALL_PARTS: ViewPart[] = ['list', 'status', 'tasks', 'playback', 'prefs'];

/** How often running downloads' progress is published (status changes go out at once). */
const PROGRESS_MS = 250;

export class Session extends EventEmitter<{ view: [View]; patch: [Set<ViewPart>] }> {
  readonly queue: TaskQueue;
  private handlers: Handler[] = [];
  private commands = new Map<string, Command>();
  private state: ListState = { status: IDLE, items: [] };
  private ctx?: Context;
  private controller?: AbortController;
  /** Earlier lists of the current input, for back(). */
  private history: ListState[] = [];
  /** The list a running pick started from: its first items() call is a step deeper, not a refresh. */
  private navFrom?: ListState;
  private emitTimer?: NodeJS.Timeout;
  /** `@novel:<书源>`-style targets that aren't registered commands (book sources change at runtime). */
  private targets = new Map<string, () => ArgOption[]>();
  private pickCount = 0;
  private previewController?: AbortController;
  /** Clip of the last preview shown, for play(). */
  private clip?: { title: string; clip: AudioClip };
  private player?: Player;
  private playback?: { state: Playback; controller: AbortController };
  /** Says why an input is refused (server mode: settings from the network …), or undefined to run it. */
  private filter?: (text: string) => string | undefined;
  private recorded = new Set<string>();
  private localVersion = 0;
  private dirty = new Set<ViewPart>();
  private listVersion = 0;
  private listCache?: { version: number; part: Pick<View, 'items' | 'columns' | 'batch' | 'canBack'> };
  private listJson?: { version: number; json: string };
  private taskStatus = new Map<string, string>();
  private tasksAt = 0;
  private progressTimer?: NodeJS.Timeout;
  private commandCache?: { key: string; map: Map<string, Command> };

  constructor(queue = new TaskQueue({ concurrency: loadConfig().concurrency })) {
    super();
    this.queue = queue;
    this.queue.on('change', (task) => {
      this.record(task);
      this.taskChanged(task);
    });
    const onSetting = (key: string) => {
      if (key === 'concurrency') this.queue.setConcurrency(settingNumber('concurrency'));
      this.changed('prefs', 'list');
    };
    settingEvents.on('change', onSetting);
    this.dispose = () => {
      settingEvents.off('change', onSetting);
      for (const t of this.queue.list()) this.queue.cancel(t.id);
      this.controller?.abort();
      this.stopPlay();
    };
    this.registerCommand({ name: 'help', usage: '@help', run: (_, ctx) => this.help(ctx) });
    // Searches and @parse are parsed as intents when something follows; these entries give
    // completion and explain what is missing otherwise.
    for (const type of SEARCH_TYPES) {
      const missing = (cmd: string) => (_: string[], ctx: Context) =>
        ctx.status(`在后面输入${SEARCH_LABEL[type]}，例如 @${cmd} ${SEARCH_EXAMPLE[type]}`, 'error');
      const hint = (where: string) => () => [{ value: '', meta: `输入${SEARCH_LABEL[type]}，Enter 搜索${where}（例如 ${SEARCH_EXAMPLE[type]}）` }];
      this.registerCommand({ name: type, usage: `@${type} <${SEARCH_LABEL[type]}>（${SEARCH_NAME[type]}，聚合搜索）`, run: missing(type), complete: hint('所有平台') });
    }
    this.registerCommand({
      name: 'parse',
      usage: '@parse <链接或编号>',
      complete: () => [{ value: '', meta: `粘贴链接，或输入${idLabels() || '各平台的编号'}` }],
      run: (args, ctx) =>
        ctx.status(
          args.length
            ? `没有识别出"${args.join(' ')}"。可以是链接${idLabels() ? `、${idLabels()}` : ''}；不确定时用 @parse:<平台> 指定。`
            : '在后面输入链接或编号',
          'error',
        ),
    });
  }

  /** Stop everything this session runs and detach it (server mode drops idle client sessions). */
  readonly dispose: () => void;

  /** Refuse some inputs, e.g. settings typed in a browser when serving to the network. */
  setInputFilter(filter: ((text: string) => string | undefined) | undefined): void {
    this.filter = filter;
  }

  /** Show a message in the status line without changing the list. */
  notify(text: string, tone: Tone = 'idle'): void {
    this.state = { ...this.state, status: { text, tone } };
    this.changed('status');
  }

  /** Finished downloads, newest first (kept in the database across runs). */
  downloads(limit = 50): DownloadRecord[] {
    try {
      return downloadStore.list(limit);
    } catch {
      return [];
    }
  }

  /** Forget a download record; with `deleteFile`, also delete the file. */
  async forgetDownload(id: string, deleteFile = false): Promise<void> {
    const rec = this.downloads(500).find((r) => r.id === id);
    try {
      downloadStore.remove(id);
    } catch {
      // no database
    }
    if (deleteFile && rec?.path) await rm(rec.path, { force: true, recursive: true });
    this.changed('tasks');
  }

  private record(task: Task): void {
    if ((task.status !== 'done' && task.status !== 'error' && task.status !== 'canceled') || this.recorded.has(task.id)) return;
    this.recorded.add(task.id);
    try {
      downloadStore.add({ id: task.id, title: task.title, kind: task.kind, status: task.status, path: task.outputPath, error: task.error, finished: Date.now() });
    } catch {
      // no database: the history just isn't kept
    }
  }

  /**
   * Every command: this session's own (built-ins, @web …) over the installed modules', plus a
   * `@music:<id>` / `@video:<id>` entry per registered platform. Rebuilt when either changes.
   */
  private commandMap(): Map<string, Command> {
    const key = `${registry.version}:${this.localVersion}`;
    if (this.commandCache?.key === key) return this.commandCache.map;
    const map = new Map<string, Command>();
    for (const type of SEARCH_TYPES) {
      const own = this.commands.get(type);
      if (own) map.set(type, own);
    }
    for (const p of registry.platforms) {
      const name = `${p.type}:${p.id}`;
      map.set(name, {
        name,
        usage: `@${name} <${SEARCH_LABEL[p.type]}>（只搜 ${p.name}）`,
        run: (_, ctx) => ctx.status(`在后面输入${SEARCH_LABEL[p.type]}，例如 @${name} ${SEARCH_EXAMPLE[p.type]}`, 'error'),
        complete: () => [{ value: '', meta: `输入${SEARCH_LABEL[p.type]}，Enter 搜索，只搜 ${p.name}（例如 ${SEARCH_EXAMPLE[p.type]}）` }],
      });
    }
    for (const [name, c] of registry.commands) map.set(name, c);
    for (const [name, c] of this.commands) map.set(name, c);
    this.commandCache = { key, map };
    return map;
  }

  private target(type: string): (() => ArgOption[]) | undefined {
    return this.targets.get(type) ?? registry.targets.get(type);
  }

  /** This session's own handlers (a demo, tests) over the installed modules'. */
  private allHandlers(): Handler[] {
    return [...this.handlers, ...registry.handlers];
  }

  register(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  registerCommand(cmd: Command): this {
    this.commands.set(cmd.name, cmd);
    this.localVersion++;
    return this;
  }

  /** Targets for `@<type>:<target>` beyond the registered ones (e.g. book sources for @novel:). */
  registerTargets(type: string, list: () => ArgOption[]): this {
    this.targets.set(type, list);
    return this;
  }

  /**
   * Completions for what is being typed: command names (prefix matches first, then names that
   * contain the text, so "@qq" finds @music:qq-music), `@novel:<书源>`, and after a space the
   * values the command takes at that argument (sites for @login, platforms for @proxy …).
   */
  complete(text: string): Completion[] {
    if (!text.startsWith('@')) return [];
    const space = text.search(/\s/);
    if (space < 0) {
      const typed = text.slice(1).toLowerCase();
      const out: Completion[] = [];
      const target = typed.match(/^([\w-]+):(.*)$/);
      const extra = target ? this.target(target[1]!) : undefined;
      if (target && extra) {
        for (const o of extra()) {
          if (o.value.toLowerCase().includes(target[2]!)) out.push({ title: `@${target[1]}:${o.value}`, meta: o.meta, fill: `@${target[1]}:${o.value} ` });
        }
      }
      const list = this.commandList();
      const starts = list.filter((c) => c.name.startsWith(typed));
      const contains = typed ? list.filter((c) => !c.name.startsWith(typed) && c.name.includes(typed)) : [];
      for (const c of [...starts, ...contains]) {
        // A command typed in full that takes nothing (@help, @clear) runs on Enter.
        out.push({ title: c.usage, fill: `@${c.name} `, ready: c.name === typed && (!this.commandMap().get(c.name)?.complete || !!this.commandMap().get(c.name)?.bare) });
      }
      return out.slice(0, 60);
    }
    const name = text.slice(1, space);
    const cmd = this.commandMap().get(name);
    if (!cmd?.complete) return [];
    const args = splitArgs(text.slice(space + 1));
    if (/\s$/.test(text) || !args.length) args.push('');
    const partial = args[args.length - 1]!.toLowerCase();
    const head = ['@' + name, ...args.slice(0, -1).map(quote)].join(' ');
    const options = cmd.complete(args);
    const hints = options.filter((o) => !o.value);
    const values = options.filter((o) => o.value && o.value.toLowerCase().includes(partial));
    // Prefix matches first; a value already typed in full still shows (Enter runs it).
    values.sort((a, b) => Number(!a.value.toLowerCase().startsWith(partial)) - Number(!b.value.toLowerCase().startsWith(partial)));
    return [
      ...values.map((o) => ({ title: `${head} ${o.value}`, meta: o.meta, fill: `${head} ${quote(o.value)} `, ready: o.value.toLowerCase() === partial })),
      ...(values.length ? [] : hints.map((o) => ({ title: o.meta ?? '' }))),
    ];
  }

  /**
   * How much of the text is a complete, known `@command` (its length in characters, 0 for none),
   * for the UIs to show it in the theme colour: `@video`, `@music:qq`, `@novel:笔趣阁`, `@login` …
   */
  commandMark(text: string): number {
    const name = text.match(/^@([^\s@]+)/)?.[1];
    if (!name) return 0;
    const known = (() => {
      if (this.commandMap().has(name)) return true;
      const typed = name.match(/^(music|video):(.+)$/);
      if (typed) return !!registry.resolvePlatform(typed[1] as 'music' | 'video', typed[2]!);
      const target = name.match(/^([\w-]+):(.+)$/);
      if (target && target[1] !== 'parse') return !!this.target(target[1]!)?.().some((o) => o.value === target[2]);
      return !!target; // @parse:<hint>, @anime:<source>: checked when run
    })();
    return known ? name.length + 1 : 0;
  }

  /** Registered commands, for completion in the UIs. */
  commandList(): { name: string; usage: string }[] {
    // Searches and @parse first (most used, in a fixed order), then settings alphabetically.
    const first = ['novel', 'music', 'video', 'anime', 'parse', 'login'];
    const rank = (n: string) => {
      const i = first.indexOf(n.split(':')[0]!);
      return i < 0 ? first.length : i;
    };
    // Within a search, the bare command first, then its platforms in registration order.
    const order = [...this.commandMap().keys()];
    const within = (a: string, b: string) =>
      rank(a) < first.length ? Number(a.includes(':')) - Number(b.includes(':')) || order.indexOf(a) - order.indexOf(b) : a.length - b.length || a.localeCompare(b);
    return [...this.commandMap().values()].map(({ name, usage }) => ({ name, usage })).sort((a, b) => rank(a.name) - rank(b.name) || within(a.name, b.name));
  }

  view(): View {
    return {
      status: this.state.status,
      ...this.listPart(),
      tasks: this.queue.list(),
      playback: this.playback?.state,
      prefs: uiPrefs(),
    };
  }

  /**
   * The list part of the view (items, table, batch, back), rebuilt only when the list changes and
   * kept with its JSON, so a 500-row list is serialised once per change for every browser.
   */
  private listPart(): Pick<View, 'items' | 'columns' | 'batch' | 'canBack'> {
    if (this.listCache?.version !== this.listVersion) {
      const part = {
        items: this.state.items.map(({ pick: _pick, previewer, ...item }) => {
          const out: Item = previewer ? { ...item, preview: true } : item;
          // `locked.site` as the @login id (modules may use an alias, e.g. a cookie key), or none
          // when logging in can't help there.
          return out.locked?.site ? { ...out, locked: { ...out.locked, site: registry.loginId(out.locked.site) } } : out;
        }),
        columns: this.state.columns,
        batch: this.state.batch ? { label: this.state.batch.label } : undefined,
        canBack: this.history.length > 0,
      };
      this.listCache = { version: this.listVersion, part };
    }
    return this.listCache.part;
  }

  /** JSON of the given view parts (a `patch` event's payload); the list's JSON is cached. */
  partsJson(parts: Iterable<ViewPart>): string {
    const out: string[] = [];
    for (const p of parts) {
      if (p === 'list') {
        if (this.listJson?.version !== this.listVersion) this.listJson = { version: this.listVersion, json: JSON.stringify(this.listPart()) };
        out.push(`"list":${this.listJson.json}`);
      } else if (p === 'status') out.push(`"status":${JSON.stringify(this.state.status)}`);
      else if (p === 'tasks') out.push(`"tasks":${JSON.stringify(this.queue.list())}`);
      else if (p === 'playback') out.push(`"playback":${JSON.stringify(this.playback?.state ?? null)}`);
      else if (p === 'prefs') out.push(`"prefs":${JSON.stringify(uiPrefs())}`);
    }
    return `{${out.join(',')}}`;
  }

  /** Return to the previous list (e.g. from a format list to the search results). */
  back(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.state = prev;
    this.changed('list', 'status');
    return true;
  }

  async input(text: string): Promise<void> {
    const refused = this.filter?.(text.trim());
    if (refused) return this.notify(refused, 'error');
    this.controller?.abort();
    const intent = detectIntent(text);
    const controller = new AbortController();
    this.controller = controller;
    const ctx = this.makeContext(intent, controller.signal);
    this.ctx = ctx;
    this.state = { status: IDLE, items: [] };
    this.history = [];
    this.pickCount = 0;
    this.changed('list', 'status');
    if (intent.kind === 'empty') return;
    await this.guard(ctx, () => this.dispatch(ctx));
  }

  async pick(itemId: string): Promise<void> {
    const ctx = this.ctx;
    const item = this.state.items.find((i) => i.id === itemId);
    if (!ctx || !item?.pick || item.disabled) return;
    this.navFrom = { ...this.state, status: { ...this.state.status } };
    this.pickCount++;
    try {
      await this.guard(ctx, () => item.pick!(ctx));
    } finally {
      this.navFrom = undefined;
    }
  }

  /** Details of a row (cancels a preview still loading). The clip is kept for play(). */
  async preview(itemId: string): Promise<Preview> {
    this.previewController?.abort();
    const item = this.state.items.find((i) => i.id === itemId);
    if (!item?.previewer) throw new Error('这一项没有预览。');
    const controller = new AbortController();
    this.previewController = controller;
    const signal = AbortSignal.any([controller.signal, this.controller?.signal ?? controller.signal]);
    const { clip, ...preview } = await item.previewer(signal);
    if (signal.aborted) throw new Error('已取消预览。');
    this.clip = clip ? { title: preview.title, clip } : undefined;
    return { ...preview, audio: clip ? { duration: clip.duration ?? 30, ...preview.audio } : undefined };
  }

  /** The clip of the last preview (the web UI streams it through the server). */
  previewClip(): AudioClip | undefined {
    return this.clip?.clip;
  }

  setPlayer(player: Player): void {
    this.player = player;
  }

  /** Play the last preview's clip, or stop what is playing. */
  togglePlay(): void {
    if (this.playback) return this.stopPlay();
    const clip = this.clip;
    if (!clip || !this.player) return;
    const controller = new AbortController();
    const duration = clip.clip.duration ?? 30;
    const entry = { state: { title: clip.title, state: 'loading', duration } as Playback, controller };
    this.playback = entry;
    this.changed('playback');
    this.player(clip.clip, {
      signal: controller.signal,
      onStart: () => {
        entry.state = { ...entry.state, state: 'playing', startedAt: Date.now() };
        this.changed('playback');
      },
    })
      .catch(() => {})
      .finally(() => {
        if (this.playback === entry) {
          this.playback = undefined;
          this.changed('playback');
        }
      });
  }

  stopPlay(): void {
    this.playback?.controller.abort();
    this.playback = undefined;
    this.changed('playback');
  }

  /** The list's batch action on the checked rows. */
  async pickMany(ids: string[]): Promise<void> {
    const ctx = this.ctx;
    const batch = this.state.batch;
    if (!ctx || !batch || !ids.length) return;
    const known = new Set(this.state.items.filter((i) => i.selectable).map((i) => i.id));
    await this.guard(ctx, () => batch.run(ids.filter((id) => known.has(id))));
  }

  pause(taskId: string): void {
    this.queue.toggle(taskId);
  }

  cancel(taskId: string): void {
    this.queue.cancel(taskId);
  }

  /** Drop a task from the list (stopping it first); with `deleteFile`, also delete what it saved. */
  async remove(taskId: string, deleteFile = false): Promise<void> {
    const task = this.queue.remove(taskId);
    if (deleteFile && task?.status === 'done' && task.outputPath) await rm(task.outputPath, { force: true, recursive: true });
  }

  private async dispatch(ctx: Context, resolved = false): Promise<void> {
    const { intent } = ctx;
    if (intent.kind === 'command') return this.runCommand(ctx);
    if (intent.kind === 'text') return this.offerSearches(ctx);
    const handler = this.handlerFor(intent);
    if (handler) return handler.handle(ctx);
    // A link no module recognises by its text (a short or share link): follow it, then route
    // by where it ends up.
    if ((intent.kind === 'video' || intent.kind === 'music') && /^https?:\/\//i.test(intent.input) && !resolved) {
      ctx.status('解析链接');
      const target = await followRedirects(intent.input, { signal: ctx.signal }).catch(() => intent.input);
      const next = detectIntent(target);
      if (target !== intent.input && next.site && this.handlerFor(next)) {
        const again = this.makeContext(next, ctx.signal);
        this.ctx = again;
        return this.dispatch(again, true);
      }
    }
    ctx.status(UNSUPPORTED[intent.kind] ?? '暂不支持这个输入。', 'error');
  }

  private handlerFor(intent: Intent): Handler | undefined {
    return this.allHandlers().find((h) => h.kinds.includes(intent.kind) && (h.match?.(intent) ?? true));
  }

  private async runCommand(ctx: Context): Promise<void> {
    const [name = '', ...args] = splitArgs(ctx.intent.input);
    const cmd = this.commandMap().get(name);
    if (!cmd) {
      const platform = name.match(/^(music|video):(.*)$/);
      if (platform) {
        const known = registry.platformsOf(platform[1] as 'music' | 'video').map((p) => p.id).join('、');
        ctx.status(`没有平台"${platform[2]}"。可用：${known}`, 'error');
        return;
      }
      ctx.status(`没有命令 @${name}，输入 @help 查看全部。`, 'error');
      return;
    }
    await cmd.run(args, ctx);
  }

  /** Plain text: nothing is guessed, the three searches are offered instead. */
  private offerSearches(ctx: Context): void {
    const q = ctx.intent.input;
    ctx.status('要搜索什么？', 'idle');
    ctx.items(
      SEARCH_TYPES.map((type) => ({
        id: `search:${type}`,
        title: `@${type} ${q}`,
        meta: SEARCH_NAME[type],
        pick: () => this.input(`@${type} ${q}`),
      })),
    );
  }

  private help(ctx: Context): void {
    ctx.status('命令', 'idle');
    ctx.items(this.commandList().map((c) => ({ id: `cmd:${c.name}`, title: c.usage })));
  }

  private async guard(ctx: Context, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (ctx.signal.aborted) return;
      ctx.status(explainError(err), 'error');
    }
  }

  private makeContext(intent: Intent, signal: AbortSignal): Context {
    const live = () => !signal.aborted;
    const session = this;
    return {
      intent,
      signal,
      config: loadConfig(),
      get picks() {
        return session.pickCount;
      },
      status: (text, tone = 'busy') => {
        if (!live()) return;
        this.state.status = { text, tone };
        this.changed('status');
      },
      items: (list, opts) => {
        if (!live()) return;
        if (this.navFrom?.items.length) {
          // Whatever was still loading into that list has stopped (a search ends when a result opens).
          const { status } = this.navFrom;
          this.history.push({ ...this.navFrom, status: status.tone === 'busy' ? { ...status, tone: 'idle' } : status });
          this.navFrom = undefined;
        }
        this.state = { status: this.state.status, items: list, columns: opts?.columns, batch: opts?.batch };
        this.changed('list');
      },
      append: (list) => {
        if (!live()) return;
        this.state.items = [...this.state.items, ...list];
        this.changed('list');
      },
      enqueue: (job) => this.queue.add(job),
      clearFinished: () => this.queue.clearFinished(),
    };
  }

  /**
   * Mark parts of the view changed. Bursts (streamed results, several statuses) are coalesced
   * into one emit per ~50 ms: `patch` with the changed parts (the web server sends only those),
   * and the whole `view` for listeners that want it (the TUI).
   */
  private changed(...parts: ViewPart[]): void {
    for (const p of parts.length ? parts : ALL_PARTS) this.dirty.add(p);
    if (parts.includes('list') || !parts.length) this.listVersion++;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const dirty = this.dirty;
      this.dirty = new Set();
      if (dirty.has('tasks')) this.tasksAt = Date.now();
      this.emit('patch', dirty);
      if (this.listenerCount('view')) this.emit('view', this.view());
    }, 50);
  }

  /**
   * A task changed. New, finished, failed or removed tasks go out with the next emit; progress of
   * running ones at most every PROGRESS_MS (a segmented download reports many times a second).
   */
  private taskChanged(task: Task): void {
    const prev = this.taskStatus.get(task.id);
    const gone = !this.queue.get(task.id);
    if (gone) this.taskStatus.delete(task.id);
    else this.taskStatus.set(task.id, task.status);
    if (gone || prev !== task.status) return this.changed('tasks');
    const wait = this.tasksAt + PROGRESS_MS - Date.now();
    if (wait <= 0) return this.changed('tasks');
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = undefined;
      this.changed('tasks');
    }, wait);
  }
}

const SEARCH_NAME: Record<SearchType, string> = { novel: '搜小说', music: '搜音乐', video: '搜视频', anime: '搜动漫' };
const SEARCH_LABEL: Record<SearchType, string> = { novel: '书名', music: '歌名', video: '关键词', anime: '番剧名' };
const SEARCH_EXAMPLE: Record<SearchType, string> = { novel: '红楼梦', music: '晴天', video: 'lofi', anime: '葬送的芙莉莲' };

const UNSUPPORTED: Partial<Record<IntentKind, string>> = {
  'video-search': '视频搜索尚未就绪。',
  video: '暂不支持这个链接。',
  music: '暂不支持这个音乐链接。',
  'music-search': '音乐搜索尚未就绪。',
  'novel-search': '小说搜索尚未就绪。',
  'anime-search': '动漫搜索尚未就绪。',
};

/** The bare ids the installed modules recognise, for hints ("BV号、网易云歌曲号 …"). */
function idLabels(): string {
  return [...new Set(registry.ids.map((r) => r.label).filter(Boolean))].join('、');
}

/** Quote an argument that contains spaces (book source names …). */
function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** Split on whitespace, keeping "quoted strings" together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? '');
  return out;
}
