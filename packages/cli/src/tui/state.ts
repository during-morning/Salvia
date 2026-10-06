import { type DownloadRecord, type Preview, type Session, type Task, type View } from '@salvia/core';
import { applyTheme, type ListItem } from './widgets/index.ts';

export const MIN_COLS = 50;
export const MIN_ROWS = 14;
export const FINAL = new Set<Task['status']>(['done', 'error', 'canceled']);

export interface Finished {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  /** The saved file, for "删除文件". */
  path?: string;
}

export type DialogState =
  | { kind: 'cancel'; focus: number }
  | { kind: 'login'; focus: number; row: Row }
  /** A finished download in the task area: forget it, or delete its file too. */
  | { kind: 'record'; focus: number; record: Finished }
  /** One task of the running download. */
  | { kind: 'task'; focus: number; task: Task };

export type Row = ListItem & { fill?: string; locked?: { reason: string; site?: string }; preview?: boolean; ready?: boolean };

export interface PreviewState {
  row: Row;
  state: 'loading' | 'ready' | 'error';
  data?: Preview;
  error?: string;
  tab: number;
  /** First visible line of the section text. */
  top: number;
  /**
   * Lists seen while the detail is open: the results it was opened from, then the download options
   * the pick produced, then deeper ones (换源 …). Esc walks back down this stack.
   */
  keys: string[];
}

/** Identity of a list, to notice when a pick has replaced it. */
export const itemsKey = (view: View) => view.items.map((i) => i.id).join('\n');

export type ToastState = { id: number; text: string; tone: 'ok' | 'error' | 'info' };

/** Starting points shown on the empty home screen; activating one fills the input. */
export const EXAMPLES: Row[] = [
  { id: 'ex:novel', title: '@novel <书名>', meta: '搜小说 · 所有书源', fill: '@novel ' },
  { id: 'ex:music', title: '@music <歌名>', meta: '搜音乐 · 网易云 QQ 酷狗 酷我 咪咕（@music:all 全部平台）', fill: '@music ' },
  { id: 'ex:video', title: '@video <关键词>', meta: '搜视频 · B站 + YouTube', fill: '@video ' },
  { id: 'ex:anime', title: '@anime <番剧名>', meta: '搜动漫 · Bangumi 资料 + B站正版番剧', fill: '@anime ' },
  { id: 'ex:parse', title: '@parse <链接或编号>', meta: 'BV号 · 抖音分享链接 · 番剧 ep/ss · 歌曲号 · 链接', fill: '@parse ' },
  { id: 'ex:login', title: '@login <网站>', meta: '浏览器登录 · B站 网易云 QQ音乐 抖音 Spotify', fill: '@login ' },
  { id: 'ex:setting', title: '@setting', meta: '设置 · 主题、样式、偏好、多线程', fill: '@setting' },
  { id: 'ex:platform', title: '@music:qq-music <歌名>', meta: '只搜一个平台（Tab 补全平台名）', fill: '@music:' },
  { id: 'ex:help', title: '@help', meta: '全部命令与设置', fill: '@help' },
];


export interface State {
  view: View;
  text: string;
  /** In graphemes. */
  caret: number;
  /** Last submitted input; Enter on unchanged text activates the selected row instead. */
  sent: string;
  focus: 'input' | 'list' | 'tasks';
  sel: number;
  /** Selected row in the task area (browse) or the download's task list. */
  taskSel: number;
  selId?: string;
  /** Single-threaded flow: browsing, or a download screen until its tasks finish. */
  mode: 'browse' | 'download';
  watch: string[];
  btn: number;
  dialog: DialogState | null;
  finished: Finished[];
  started: number;
  /** Show results that can't be obtained right now (members-only, region); hidden by default. */
  showLocked: boolean;
  /** Details of one result, in place of the list. */
  preview: PreviewState | null;
  toast?: ToastState;
  /** A detail closed before its pick finished: undo that pick's list when it lands. */
  abandon?: string;
  /** Rows checked for the list's batch action, valid for the list they were checked in. */
  checked: { key: string; ids: Set<string> };
}

export const NONE = new Set<string>();
/** The checked rows of the list on screen. */
export const checkedOf = (s: State) => (s.view.batch && s.checked.key === itemsKey(s.view) ? s.checked.ids : NONE);

/** A download record from the database, as the task area shows it. */
export const toFinished = (r: DownloadRecord): Finished => ({
  id: r.id,
  title: r.title,
  ok: r.status === 'done',
  detail: r.status === 'done' ? (r.path ?? '完成') : r.status === 'canceled' ? '已取消' : (r.error ?? '失败'),
  path: r.status === 'done' ? r.path : undefined,
});

/** @setting theme / animation, applied to the widgets' colours. */
export function themeFrom(view: View): void {
  if (view.prefs) applyTheme(view.prefs.accent, view.prefs.ok, view.prefs.animation);
}

export function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** The list currently shown: command completion, results, or the home examples. */
let rowsMemo: { key: unknown[]; out: { rows: Row[]; completing: boolean; hidden: number } } | undefined;

/** rowsOf for the same inputs is computed once (it runs several times per keypress and render). */
export function rowsOf(s: State, session: Session): { rows: Row[]; completing: boolean; hidden: number } {
  const key = [s.view, s.text, s.sent, s.mode, s.preview, s.showLocked, session];
  if (rowsMemo && rowsMemo.key.every((k, i) => k === key[i])) return rowsMemo.out;
  const out = computeRows(s, session);
  rowsMemo = { key, out };
  return out;
}

function computeRows(s: State, session: Session): { rows: Row[]; completing: boolean; hidden: number } {
  // While an @command is being typed: command names, then the values its arguments take.
  if (s.mode === 'browse' && !s.preview && s.text.startsWith('@') && s.text !== s.sent) {
    const list = session.complete(s.text);
    if (list.length) {
      const rows = list.map((c, i) => ({ id: `cmp:${c.fill ?? `hint${i}`}`, title: c.title, meta: c.meta, fill: c.fill, ready: c.ready, disabled: !c.fill }));
      return { rows, completing: true, hidden: 0 };
    }
  }
  if (s.view.items.length) {
    const all = s.view.items.map((i) => ({
      id: i.id,
      title: i.title,
      meta: i.locked ? ['需登录', i.meta].filter(Boolean).join(' · ') : i.meta,
      disabled: i.disabled,
      locked: i.locked,
      preview: i.preview,
      tone: i.locked ? ('locked' as const) : undefined,
      cells: i.cells,
      selectable: i.selectable && !i.locked && !i.disabled,
    }));
    const rows = s.showLocked ? all : all.filter((r) => !r.locked);
    return { rows, completing: false, hidden: all.length - rows.length };
  }
  return { rows: !s.sent && !s.view.status.text ? EXAMPLES : [], completing: false, hidden: 0 };
}

/** How many results are hidden (or would be, when shown) because they can't be obtained. */
export function lockedCount(s: State): number {
  return s.view.items.filter((i) => i.locked).length;
}

/** The rest of the highlighted completion after what is typed, shown dimmed in the input. */
export function ghostOf(text: string, row: Row | undefined): string {
  if (!row?.fill || !row.fill.toLowerCase().startsWith(text.toLowerCase())) return '';
  return row.fill.slice(text.length).trimEnd();
}

export const firstUsable = (rows: Row[]) => Math.max(0, rows.findIndex((r) => !r.disabled));
