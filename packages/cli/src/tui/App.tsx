import { useEffect, useReducer, useRef } from 'react';
import { selectionEvents } from './select.ts';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { reachEvents, type Session, type Task, type View } from '@salvia/core';
import stringWidth from 'string-width';
import { serverEvents, serverMode } from '../server-mode.ts';
import { MIN_COLS, MIN_ROWS, FINAL, type Finished, type Row, itemsKey, type ToastState, EXAMPLES, type State, NONE, checkedOf, toFinished, themeFrom, rowsOf, lockedCount, ghostOf, firstUsable } from './state.ts';
import { TaskLine } from './views/TaskLine.tsx';
import { DownloadPanel } from './views/DownloadPanel.tsx';
import { DetailView } from './views/DetailView.tsx';
import { ServerPanel } from './views/ServerPanel.tsx';
import { ACCENT, Toggle, Dialog, ERR, KeyHints, ListView, OK, Rule, TextInput, fit, graphemes, type Hint } from './widgets/index.ts';

export function App({ session }: { session: Session }) {
  const { columns, rows: screenRows } = useWindowSize();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // All interaction state lives in one ref that handlers update synchronously, so several keys
  // arriving in one chunk (a paste followed by Enter) each see the result of the previous one.
  const first = session.view();
  themeFrom(first);
  const S = useRef<State>({
    view: first,
    text: '',
    caret: 0,
    sent: '',
    focus: 'input',
    sel: 0,
    taskSel: 0,
    mode: 'browse',
    watch: [],
    btn: 0,
    dialog: null,
    finished: session.downloads(20).map(toFinished),
    started: 0,
    showLocked: first.prefs?.showLocked ?? false,
    preview: null,
    checked: { key: '', ids: new Set() },
  });
  const known = useRef(new Set(session.queue.list().map((t) => t.id)));
  const previewSeq = useRef(0);
  const toastTimer = useRef<NodeJS.Timeout>(undefined);
  /** Recent total download speed, for the sparkline. */
  const speeds = useRef<{ at: number; values: number[] }>({ at: 0, values: [] });
  const lastOk = useRef('');

  const update = (patch: Partial<State>) => {
    Object.assign(S.current, patch);
    // Keep the selection on the same row across list refreshes (streamed results, progress ticks).
    const { rows } = rowsOf(S.current, session);
    const kept = rows.findIndex((r) => r.id === S.current.selId && !r.disabled);
    if ('sel' in patch) S.current.selId = rows[S.current.sel]?.id;
    else if (kept >= 0) S.current.sel = kept;
    else {
      S.current.sel = firstUsable(rows);
      S.current.selId = rows[S.current.sel]?.id;
    }
    rerender();
  };

  const toast = (text: string, tone: ToastState['tone'] = 'ok') => {
    clearTimeout(toastTimer.current);
    update({ toast: { id: Date.now(), text, tone } });
    toastTimer.current = setTimeout(() => update({ toast: undefined }), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // ---------- session events: results, and the download screen lifecycle ----------
  useEffect(() => {
    const onView = (view: View) => {
      const s = S.current;
      // Confirmations ("已加入下载", "已保存…") also pop up as a toast.
      if (view.status.tone === 'ok' && view.status.text && view.status.text !== lastOk.current) toast(view.status.text);
      lastOk.current = view.status.tone === 'ok' ? view.status.text : '';
      const key = itemsKey(view);
      if (s.abandon !== undefined && key !== s.abandon) {
        S.current.abandon = undefined;
        if (session.back()) return;
      }
      if (s.preview && key !== s.preview.keys[s.preview.keys.length - 1]) {
        const keys = s.preview.keys;
        // Back one level (Esc) pops; a new list (the pick's options, 换源 …) pushes.
        S.current.preview = { ...s.preview, keys: keys.length > 1 && keys[keys.length - 2] === key ? keys.slice(0, -1) : [...keys, key] };
      }
      if (s.mode === 'download') {
        const now = Date.now();
        if (now - speeds.current.at > 400) {
          const total = view.tasks.reduce((a, t) => a + (t.status === 'running' ? (t.speed ?? 0) : 0), 0);
          speeds.current = { at: now, values: [...speeds.current.values, total].slice(-120) };
        }
      }
      const fresh = view.tasks.filter((t) => !known.current.has(t.id)).map((t) => t.id);
      fresh.forEach((id) => known.current.add(id));
      if (fresh.length) {
        const entering = s.mode === 'browse';
        if (entering) {
          speeds.current = { at: 0, values: [] };
          session.stopPlay();
        }
        update({ view, mode: 'download', preview: null, watch: [...s.watch, ...fresh], ...(entering ? { btn: 0, started: Date.now() } : {}) });
        return;
      }
      const watched = view.tasks.filter((t) => s.watch.includes(t.id));
      if (s.mode === 'download' && !watched.length) {
        // Every task of this download was removed.
        update({ view, mode: 'browse', watch: [], dialog: null, text: '', caret: 0, sent: '', focus: 'input', taskSel: 0 });
        void session.input('');
        return;
      }
      if (s.mode === 'download' && watched.every((t) => FINAL.has(t.status))) {
        // Finished, failed and canceled downloads are in the database now.
        session.queue.clearFinished();
        update({ view, mode: 'browse', watch: [], dialog: null, text: '', caret: 0, sent: '', focus: 'input', taskSel: 0, finished: session.downloads(20).map(toFinished) });
        void session.input('');
        return;
      }
      update({ view });
    };
    const onViewThemed = (view: View) => {
      themeFrom(view);
      onView(view);
    };
    session.on('view', onViewThemed);
    // Server mode (@web:server) redraws as clients come and go.
    const onServer = () => rerender();
    serverEvents.on('change', onServer);
    // YouTube unreachable from this network (checked at start-up): say what changes.
    const onReach = (site: string, ok: boolean) => {
      if (site === 'youtube' && !ok) toast('YouTube 无法访问：视频搜索和歌曲匹配改用 B站', 'info');
    };
    reachEvents.on('change', onReach);
    const onCopied = (chars: number) => toast(`已复制 ${chars} 个字符`);
    selectionEvents.on('copied', onCopied);
    return () => {
      session.off('view', onViewThemed);
      serverEvents.off('change', onServer);
      reachEvents.off('change', onReach);
      selectionEvents.off('copied', onCopied);
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- actions (all read S.current, never render-time values) ----------
  const edit = (text: string, caret: number) => {
    const s = S.current;
    // Emptying the box goes back to the home screen.
    if (!text && s.text && (s.sent || s.view.items.length || s.view.status.text || s.preview)) {
      if (s.preview) closePreview();
      update({ text: '', caret: 0, sent: '', focus: 'input', showLocked: !!s.view.prefs?.showLocked, abandon: undefined });
      void session.input('');
      return;
    }
    update({ text, caret, focus: 'input' });
  };
  const fill = (text: string) => edit(text, graphemes(text).length);
  const run = (input: string) => {
    // Each new search starts with unavailable results hidden again.
    if (S.current.preview) closePreview();
    update({ sent: input, focus: input ? 'list' : 'input', showLocked: !!S.current.view.prefs?.showLocked, abandon: undefined });
    void session.input(input);
  };
  const submit = () => run(S.current.text.trim());
  const activate = (i: number) => {
    const row = rowsOf(S.current, session).rows[i];
    if (!row || row.disabled) return;
    if (row.fill === '@help') {
      fill('@help');
      return run('@help');
    }
    if (row.fill !== undefined) return fill(row.fill);
    // Unavailable for a site's login (members, quality): offer to log in. Unavailable for want of
    // any source (an anime B站 doesn't carry): its details still open.
    if (row.locked && (row.locked.site || !row.preview)) return update({ dialog: { kind: 'login', focus: 0, row } });
    // A result with details opens them, with its download options underneath.
    if (row.preview && !S.current.preview) return openDetail(row, i);
    if (row.id.startsWith('search:')) {
      // An offered "@novel …" row runs as if typed; show it in the box.
      edit(row.title, graphemes(row.title).length);
      update({ sent: row.title });
    }
    update({ sel: i });
    void session.pick(row.id);
  };
  // ---------- preview ----------
  const openDetail = (row: Row, i: number) => {
    const seq = ++previewSeq.current;
    update({ preview: { row, state: 'loading', tab: 0, top: 0, keys: [itemsKey(S.current.view)] }, focus: 'list', sel: i, abandon: undefined });
    // Both read the row from the current list, so start the preview before the pick replaces it.
    session
      .preview(row.id)
      .then((data) => {
        const p = S.current.preview;
        if (seq === previewSeq.current && p) update({ preview: { ...p, state: 'ready', data } });
      })
      .catch((err: unknown) => {
        const p = S.current.preview;
        if (seq === previewSeq.current && p) update({ preview: { ...p, state: 'error', error: err instanceof Error ? err.message : String(err) } });
      });
    void session.pick(row.id);
  };
  function closePreview() {
    const p = S.current.preview;
    previewSeq.current++;
    session.stopPlay();
    update({ preview: null });
    if (!p) return;
    // Back to the results: undo the pick's list, or — still loading — undo it once it arrives.
    if (p.keys.length > 1) session.back();
    else S.current.abandon = p.keys[0];
  }
  /** Esc in the detail: one level up within the download area, then back to the results. */
  const escDetail = () => {
    const p = S.current.preview;
    if (p && p.keys.length > 2) session.back();
    else closePreview();
  };
  const previewTab = (tab: number) => {
    const p = S.current.preview;
    const n = p?.data?.sections.length ?? 0;
    if (p && n) update({ preview: { ...p, tab: (tab + n) % n, top: 0 } });
  };
  const previewScroll = (top: number) => {
    const p = S.current.preview;
    if (p) update({ preview: { ...p, top: Math.max(0, top) } });
  };
  const togglePlay = () => {
    if (S.current.preview?.data?.audio) session.togglePlay();
  };

  const move = (d: number) => {
    const { rows } = rowsOf(S.current, session);
    if (!rows.length) return;
    let i = S.current.sel;
    const step = Math.sign(d);
    for (let left = Math.abs(d); left > 0 || rows[i]?.disabled; ) {
      const next = i + step;
      if (next < 0 || next >= rows.length) break;
      i = next;
      if (!rows[i]!.disabled) left--;
    }
    if (rows[i] && !rows[i]!.disabled) update({ sel: i, focus: 'list' });
  };
  const back = () => {
    if (session.back()) return;
    const s = S.current;
    if (s.text || s.view.items.length || s.view.status.text) {
      update({ text: '', caret: 0, sent: '', focus: 'input' });
      void session.input('');
    }
  };
  const enter = () => {
    const s = S.current;
    const { rows, completing } = rowsOf(s, session);
    if (completing) {
      const row = rows[s.sel];
      // Fill the highlighted completion; run when it is already typed in full (or only hints show).
      return row?.fill && !row.ready ? fill(row.fill) : submit();
    }
    if (s.text.trim() !== s.sent || !rows.length) return submit();
    if (checkedOf(s).size) return runBatch();
    activate(s.sel);
  };

  // ---------- multi-select (lists with a batch action, e.g. 下载选中) ----------
  const setChecked = (ids: Set<string>) => update({ checked: { key: itemsKey(S.current.view), ids } });
  const toggleCheck = (i: number) => {
    const row = rowsOf(S.current, session).rows[i];
    if (!row?.selectable || !S.current.view.batch) return;
    const ids = new Set(checkedOf(S.current));
    if (ids.has(row.id)) ids.delete(row.id);
    else ids.add(row.id);
    setChecked(ids);
  };
  const toggleAll = () => {
    const selectable = rowsOf(S.current, session).rows.filter((r) => r.selectable);
    const all = selectable.length > 0 && selectable.every((r) => checkedOf(S.current).has(r.id));
    setChecked(all ? new Set() : new Set(selectable.map((r) => r.id)));
  };
  const runBatch = () => {
    const ids = [...checkedOf(S.current)];
    // Keep the list order, not the order they were checked in.
    const order = rowsOf(S.current, session).rows.map((r) => r.id);
    ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    setChecked(new Set());
    void session.pickMany(ids);
  };

  const activeTasks = () => S.current.view.tasks.filter((t) => S.current.watch.includes(t.id) && !FINAL.has(t.status));
  const anyRunning = () => activeTasks().some((t) => t.status === 'running' || t.status === 'queued');
  const togglePause = () => {
    const pause = anyRunning();
    for (const t of activeTasks()) {
      if (pause) session.queue.pause(t.id);
      else session.queue.resume(t.id);
    }
  };
  const cancelAll = () => {
    for (const t of activeTasks()) session.queue.cancel(t.id);
    update({ dialog: null });
  };
  const askCancel = () => update({ dialog: { kind: 'cancel', focus: 1 } });
  const toggleLocked = () => update({ showLocked: !S.current.showLocked });
  const close = () => update({ dialog: null });
  const browserLogin = (row: Row) => {
    const site = row.locked?.site;
    update({ dialog: null });
    // Opens a browser window on the site's login page and keeps its cookie once signed in.
    const cmd = site ? `@login ${site}` : '@login';
    fill(cmd);
    run(cmd);
  };
  const pasteCookie = (row: Row) => {
    const site = row.locked?.site;
    update({ dialog: null });
    // Pre-fill the cookie command; the user pastes their own login cookie after it.
    fill(site ? `@cookie ${site} ` : '@cookie ');
  };
  const forget = (record: Finished, deleteFile: boolean) => {
    const finished = S.current.finished.filter((f) => f.id !== record.id);
    update({
      dialog: null,
      finished,
      taskSel: Math.min(S.current.taskSel, Math.max(0, finished.length - 1)),
      focus: finished.length ? S.current.focus : 'input',
    });
    session.forgetDownload(record.id, deleteFile && !!record.path).then(
      () => toast(deleteFile && record.path ? '已删除记录和文件' : '已删除记录'),
      () => toast('文件删除失败', 'error'),
    );
  };
  const removeTask = (task: Task) => {
    update({ dialog: null, taskSel: 0 });
    void session.remove(task.id);
    toast(`已移除 ${task.title}`, 'info');
  };
  const openRecord = (i: number) => {
    const record = S.current.finished[i];
    if (record) update({ dialog: { kind: 'record', focus: 0, record }, taskSel: i, focus: 'tasks' });
  };
  const openTask = (task: Task) => update({ dialog: { kind: 'task', focus: 1, task } });
  const dialogButtons = () => {
    const d = S.current.dialog;
    if (d?.kind === 'login') {
      return [
        { label: '浏览器登录', onPress: () => browserLogin(d.row) },
        { label: '粘贴 Cookie', onPress: () => pasteCookie(d.row) },
        { label: '取消', onPress: close },
      ];
    }
    if (d?.kind === 'record') {
      return [
        { label: '删除记录', onPress: () => forget(d.record, false) },
        ...(d.record.path ? [{ label: '删除记录和文件', onPress: () => forget(d.record, true) }] : []),
        { label: '取消', onPress: close },
      ];
    }
    if (d?.kind === 'task') {
      return [
        { label: '移除任务', onPress: () => removeTask(d.task) },
        { label: '返回', onPress: close },
      ];
    }
    return [
      { label: '取消下载', onPress: cancelAll },
      { label: '继续下载', onPress: () => update({ dialog: null }) },
    ];
  };
  const downloadButtons = () => [
    { label: anyRunning() ? '暂停' : '继续', onPress: togglePause },
    { label: '取消', onPress: askCancel },
  ];

  // ---------- keyboard ----------
  usePaste((pasted) => {
    const s = S.current;
    if (s.mode !== 'browse' || s.dialog) return;
    const add = graphemes(pasted.replace(/[\r\n]+/g, ' '));
    const chars = graphemes(s.text);
    edit([...chars.slice(0, s.caret), ...add, ...chars.slice(s.caret)].join(''), s.caret + add.length);
  });

  useInput((input, key) => {
    const s = S.current;
    if (s.preview && !s.dialog && s.mode === 'browse') {
      const p = s.preview;
      const ready = p.keys.length > 1;
      const page = Math.max(1, detailHeight - 4);
      if (key.ctrl && input === 't') toggleLocked();
      else if (key.escape || key.backspace || key.delete) escDetail();
      else if (key.leftArrow || (key.tab && key.shift)) previewTab(p.tab - 1);
      else if (key.rightArrow || key.tab) previewTab(p.tab + 1);
      else if (key.upArrow) ready && move(-1);
      else if (key.downArrow) ready && move(1);
      else if (key.pageUp) previewScroll(p.top - page);
      else if (key.pageDown) previewScroll(p.top + page);
      else if (input === ' ') togglePlay();
      else if (key.return && ready) activate(S.current.sel);
      return;
    }
    if (s.dialog) {
      const n = dialogButtons().length;
      if (key.leftArrow || (key.tab && key.shift)) update({ dialog: { ...s.dialog, focus: (s.dialog.focus + n - 1) % n } });
      else if (key.rightArrow || key.tab) update({ dialog: { ...s.dialog, focus: (s.dialog.focus + 1) % n } });
      else if (key.return || input === ' ') dialogButtons()[Math.min(s.dialog.focus, n - 1)]!.onPress();
      else if (key.escape) update({ dialog: null });
      return;
    }
    if (s.mode === 'download') {
      const buttons = downloadButtons();
      const tasks = s.view.tasks.filter((t) => s.watch.includes(t.id));
      if (key.upArrow) return update({ taskSel: Math.max(0, s.taskSel - 1) });
      if (key.downArrow) return update({ taskSel: Math.max(0, Math.min(tasks.length - 1, s.taskSel + 1)) });
      if (key.delete || key.backspace) {
        const t = tasks[s.taskSel];
        if (t) openTask(t);
        return;
      }
      if (key.leftArrow || (key.tab && key.shift)) update({ btn: (s.btn + buttons.length - 1) % buttons.length });
      else if (key.rightArrow || key.tab) update({ btn: (s.btn + 1) % buttons.length });
      else if (key.return || input === ' ') buttons[s.btn]!.onPress();
      else if (key.escape) askCancel();
      return;
    }

    const chars = graphemes(s.text);
    const { rows, completing } = rowsOf(s, session);
    if (s.focus === 'tasks') {
      if (key.upArrow) {
        if (s.taskSel > 0) update({ taskSel: s.taskSel - 1 });
        else update({ focus: rows.length ? 'list' : 'input' });
        return;
      }
      if (key.downArrow) return update({ taskSel: Math.min(s.finished.length - 1, s.taskSel + 1) });
      if (key.return || key.delete || key.backspace) return openRecord(s.taskSel);
      if (key.tab || key.escape) return update({ focus: 'input' });
      // Typing goes back to the input box.
      if (input && !key.ctrl && !key.meta) {
        update({ focus: 'input' });
        typeChunk(input);
      }
      return;
    }
    const batchList = !!s.view.batch && !completing && s.focus === 'list' && s.text.trim() === s.sent;
    if (key.ctrl && input === 't') {
      if (lockedCount(s)) toggleLocked();
    } else if (batchList && input === ' ' && !key.ctrl && !key.meta) {
      toggleCheck(s.sel);
      move(1);
    } else if (batchList && key.ctrl && input === 'a') {
      toggleAll();
    } else if (key.tab) {
      if (completing && rows[s.sel]?.fill) fill(rows[s.sel]!.fill!);
      else {
        // input → results → task area → input
        const order = (['input', 'list', 'tasks'] as const).filter((f) => (f === 'list' ? rows.length > 0 : f === 'tasks' ? s.finished.length > 0 && !s.sent : true));
        update({ focus: order[(order.indexOf(s.focus) + 1) % order.length]!, taskSel: Math.min(s.taskSel, Math.max(0, s.finished.length - 1)) });
      }
    } else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-Math.max(1, bodyHeight - 1));
    else if (key.pageDown) move(Math.max(1, bodyHeight - 1));
    else if (key.escape) back();
    else if (key.return) enter();
    else if (key.leftArrow) update({ caret: Math.max(0, s.caret - 1), focus: 'input' });
    else if (key.rightArrow) {
      const ghost = completing ? ghostOf(s.text, rows[s.sel]) : '';
      if (ghost && s.caret === chars.length) fill(rows[s.sel]!.fill!);
      else update({ caret: Math.min(chars.length, s.caret + 1), focus: 'input' });
    }
    else if (key.home || (key.ctrl && input === 'a')) update({ caret: 0, focus: 'input' });
    else if (key.end || (key.ctrl && input === 'e')) update({ caret: chars.length, focus: 'input' });
    else if (key.ctrl && input === 'u') edit(chars.slice(s.caret).join(''), 0);
    else if (key.backspace || key.delete) {
      // Many terminals send DEL for Backspace, which Ink reports as delete; treat both as backspace.
      if (s.caret > 0) edit([...chars.slice(0, s.caret - 1), ...chars.slice(s.caret)].join(''), s.caret - 1);
    } else if (input && !key.ctrl && !key.meta) {
      typeChunk(input);
    }
  });

  /**
   * Text that arrives as one chunk can carry control keys (a paste ending in Enter on terminals
   * without bracketed paste, or fast typing): apply them in order instead of inserting them.
   */
  function typeChunk(chunk: string) {
    let pending = '';
    const flushText = () => {
      if (!pending) return;
      const st = S.current;
      const chars = graphemes(st.text);
      const add = graphemes(pending);
      edit([...chars.slice(0, st.caret), ...add, ...chars.slice(st.caret)].join(''), st.caret + add.length);
      pending = '';
    };
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') {
        flushText();
        enter();
      } else if (ch === '\u0015') {
        flushText();
        const st = S.current;
        edit(graphemes(st.text).slice(st.caret).join(''), 0);
      } else if (ch === '\u007f' || ch === '\b') {
        flushText();
        const st = S.current;
        const chars = graphemes(st.text);
        if (st.caret > 0) edit([...chars.slice(0, st.caret - 1), ...chars.slice(st.caret)].join(''), st.caret - 1);
      } else if (ch >= ' ' || ch === '\t') {
        pending += ch === '\t' ? ' ' : ch;
      }
    }
    flushText();
  }

  // ---------- layout ----------
  const s = S.current;
  const width = columns;
  // The task area belongs to the home screen only; results, details and downloads get the room.
  const server = serverMode();
  const home = s.mode === 'browse' && !s.sent && !s.preview && !server;
  const taskLines = home ? Math.max(1, Math.min(4, s.finished.length)) : 0;
  const taskArea = taskLines ? taskLines + 1 : 0;
  // input box (3) + section rule (1) + task area + key hints (1)
  const bodyHeight = Math.max(1, screenRows - 3 - 1 - taskArea - 1);
  // Detail view: preview on top, a framed box with 试听 and the download options below.
  const detailHeight = Math.max(5, Math.floor(bodyHeight * 0.55));
  const boxHeight = Math.max(4, bodyHeight - detailHeight);

  if (columns < MIN_COLS || screenRows < MIN_ROWS) {
    return (
      <Box width={columns} height={screenRows} alignItems="center" justifyContent="center">
        <Text color={ACCENT}>
          窗口太小（当前 {columns}×{screenRows}，至少 {MIN_COLS}×{MIN_ROWS}）
        </Text>
      </Box>
    );
  }

  const { rows, completing, hidden } = rowsOf(s, session);
  const locked = s.mode === 'browse' && !completing ? lockedCount(s) : 0;
  const toggleLabel = s.showLocked ? `隐藏不可用 ${locked}` : `显示不可用 ${locked}`;
  const toggleWidth = locked ? stringWidth(toggleLabel) + 4 : 0;
  const status = s.view.status;
  const watched = s.view.tasks.filter((t) => s.watch.includes(t.id));
  const buttons = downloadButtons();
  const checked = s.mode === 'browse' && !completing ? checkedOf(s) : NONE;
  const batch = !completing && s.view.batch && rows.some((r) => r.selectable) ? s.view.batch : undefined;
  const enterLabel = completing ? '补全' : s.text.trim() !== s.sent ? '执行' : checked.size ? `${batch?.label ?? '下载选中'} ${checked.size}` : '选择';
  const browseHints: Hint[] =
    s.focus === 'tasks'
      ? [
          { keys: 'Enter/Del', label: '删除…', onPress: () => openRecord(s.taskSel) },
          { keys: '↑↓', label: '选择' },
          { keys: 'Tab', label: '回到输入框', onPress: () => update({ focus: 'input' }) },
        ]
      : [
          { keys: 'Enter', label: rows[s.sel]?.preview && enterLabel === '选择' ? '详情' : enterLabel, onPress: enter },
          ...(batch
            ? [
                { keys: 'Space', label: '勾选', onPress: () => toggleCheck(s.sel) },
                { keys: 'Ctrl+A', label: checked.size && rows.filter((r) => r.selectable).every((r) => checked.has(r.id)) ? '清空' : '全选', onPress: toggleAll },
              ]
            : []),
          { keys: 'Esc', label: s.view.canBack ? '返回上一级' : '清空', onPress: back },
          { keys: '↑↓', label: '选择' },
          { keys: completing ? 'Tab/→' : 'Tab', label: completing ? '补全' : '切换焦点' },
          ...(locked ? [{ keys: 'Ctrl+T', label: s.showLocked ? '隐藏不可用' : '显示不可用', onPress: toggleLocked }] : []),
        ];
  const downloadHints: Hint[] = [
    { keys: '←→', label: '切换按钮' },
    { keys: 'Enter', label: '执行', onPress: () => buttons[s.btn]!.onPress() },
    ...(watched.length > 1 ? [{ keys: '↑↓ Del', label: '移除某个任务' }] : []),
    { keys: 'Esc', label: '取消下载', onPress: askCancel },
  ];
  const previewHints: Hint[] = [
    { keys: 'Enter', label: '下载', onPress: () => (s.preview?.keys.length ?? 0) > 1 && activate(s.sel) },
    { keys: '↑↓', label: '选择' },
    ...(s.preview?.data?.audio ? [{ keys: 'Space', label: s.view.playback ? '停止试听' : '试听', onPress: togglePlay }] : []),
    { keys: '←→', label: '标签' },
    { keys: 'PgUp/PgDn', label: '滚动' },
    { keys: 'Esc', label: '返回', onPress: escDetail },
  ];
  const dialogHints: Hint[] = [
    { keys: '←→', label: '切换按钮' },
    { keys: 'Enter', label: '确定' },
    { keys: 'Esc', label: '关闭', onPress: close },
  ];

  const d = s.dialog;
  const dialog = d && (
    <Dialog
      title={d.kind === 'login' ? '需要登录' : d.kind === 'record' ? '删除下载记录' : d.kind === 'task' ? '移除任务' : '取消下载？'}
      message={
        d.kind === 'login'
          ? `"${d.row.title}"${d.row.locked?.reason ?? '暂时无法获取'}。登录你自己的账号后，可获取账号有权限的内容。"浏览器登录"会打开一个浏览器窗口，登录后自动保存；也可以粘贴浏览器里该网站的 Cookie。`
          : d.kind === 'record'
            ? `${d.record.title}${d.record.path ? `\n${d.record.path}` : ''}`
            : d.kind === 'task'
              ? `停止并移除"${d.task.title}"？其他任务继续下载。`
              : `还有 ${activeTasks().length} 个下载未完成。已下载的部分会保留，下次可以继续。`
      }
      buttons={dialogButtons()}
      focus={d.focus}
      width={width}
      height={s.mode === 'browse' ? bodyHeight : bodyHeight + 1}
    />
  );

  return (
    <Box flexDirection="column" width={width} height={screenRows}>
      <Box width={width} height={3}>
        <TextInput
          value={s.mode === 'download' ? s.sent : s.text}
          caret={s.caret}
          focused={s.mode === 'browse' && !s.dialog && s.focus === 'input'}
          disabled={s.mode === 'download'}
          placeholder="粘贴链接，或输入 @ 开始（@music 晴天）"
          ghost={completing && s.focus === 'input' ? ghostOf(s.text, rows[s.sel]) : ''}
          mark={graphemes(s.text.slice(0, session.commandMark(s.text))).length}
          width={width - toggleWidth}
          onCaret={(caret) => update({ caret, focus: 'input' })}
          onFocus={() => update({ focus: 'input' })}
        />
        {locked ? <Toggle label={toggleLabel} on={s.showLocked} width={toggleWidth} onPress={toggleLocked} /> : null}
      </Box>

      {server && s.mode === 'browse' && !dialog ? (
        <ServerPanel mode={server} status={status} width={width} height={bodyHeight + 1} onQuit={() => (fill('@web:server quit'), run('@web:server quit'))} />
      ) : s.mode === 'browse' ? (
        <>
          {s.preview && !dialog ? (
            <DetailView
              p={s.preview}
              width={width}
              detailHeight={detailHeight}
              boxHeight={boxHeight}
              playback={s.view.playback}
              status={status}
              rows={rows}
              selected={s.sel}
              hidden={hidden}
              onTab={previewTab}
              onScroll={previewScroll}
              onPlay={togglePlay}
              onBack={escDetail}
              onSelect={(sel) => update({ sel })}
              onActivate={activate}
            />
          ) : (
            <>
              <Rule
                title={completing ? '补全' : '结果'}
                detail={
                  completing
                    ? rows.some((r) => r.fill)
                      ? 'Tab / → 接受灰色提示 · ↑↓ 选择 · Enter 补全或执行'
                      : 'Enter 执行'
                    : [status.text || (rows === EXAMPLES ? '从这里开始' : ''), hidden ? `已隐藏 ${hidden} 个需登录的结果` : ''].filter(Boolean).join(' · ')
                }
                busy={!completing && status.tone === 'busy'}
                tone={status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'ok' : undefined}
                width={width}
                action={!completing && (s.view.canBack || s.sent) ? { label: 'ESC 返回', onPress: back } : undefined}
              />
              {dialog ?? (
                <ListView
                  items={rows}
                  selected={s.sel}
                  height={bodyHeight}
                  width={width}
                  focused={s.focus === 'list' || completing}
                  onSelect={(sel) => update({ sel })}
                  onActivate={activate}
                  columns={completing || s.view.prefs?.table === false ? undefined : s.view.columns}
                  checked={batch ? checked : undefined}
                  onToggle={toggleCheck}
                />
              )}
            </>
          )}
        </>
      ) : (
        (dialog ?? (
          <DownloadPanel
            tasks={watched}
            width={width}
            height={bodyHeight + 1}
            started={s.started}
            buttons={buttons}
            focus={s.btn}
            selected={s.taskSel}
            onTask={openTask}
            speeds={speeds.current.values}
          />
        ))
      )}

      {taskArea ? (
        <Box flexDirection="column" height={taskArea}>
          <Rule title="任务" detail={s.finished.length ? `最近 ${s.finished.length} 个 · 点击可删除` : '没有下载记录'} width={width} />
          {s.finished.slice(Math.max(0, s.taskSel - taskLines + 1), Math.max(taskLines, s.taskSel + 1)).map((f) => (
            <TaskLine
              key={f.id}
              width={width}
              selected={s.focus === 'tasks' && s.finished[s.taskSel]?.id === f.id}
              onPress={() => openRecord(s.finished.indexOf(f))}
            >
              <Text color={f.ok ? OK : ERR}>{f.ok ? ' ✓ ' : ' ✗ '}</Text>
              <Text>{fit(f.title, Math.floor(width * 0.4))}</Text>
              <Text dimColor>{`  ${fit(f.detail, width - Math.floor(width * 0.4) - 6)}`}</Text>
            </TaskLine>
          ))}
          {!s.finished.length && <Text dimColor> 下载完成的文件会列在这里</Text>}
        </Box>
      ) : null}

      <KeyHints
        hints={s.dialog ? dialogHints : s.mode === 'download' ? downloadHints : s.preview ? previewHints : browseHints}
        width={width}
        right="鼠标可点击 · 滚轮滚动 · Ctrl+C 退出"
        toast={s.toast}
      />
    </Box>
  );
}
