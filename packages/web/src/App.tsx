import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, useCompletions, useMark, useView, type Item } from './api.ts';
import { DetailPane, type Detail } from './components/DetailPane.tsx';
import { LoginCard } from './components/LoginCard.tsx';
import { ResultList } from './components/ResultList.tsx';
import { TaskRow } from './components/TaskRow.tsx';

/** The chips under the input: each fills in its command. */
const MODES = [
  { cmd: '@video ', label: 'video', name: '视频', hint: 'B站 + YouTube' },
  { cmd: '@music ', label: 'music', name: '音乐', hint: '网易云 + QQ音乐 + Spotify' },
  { cmd: '@novel ', label: 'novel', name: '小说', hint: '所有书源' },
  { cmd: '@anime ', label: 'anime', name: '动漫', hint: 'Bangumi + B站正版番剧' },
  { cmd: '@parse ', label: 'parse', name: '解析', hint: '链接 / BV号 / 抖音分享链接 / 歌曲号' },
  { cmd: '@login ', label: 'login', name: '登录', hint: '浏览器登录 bilibili / netease / qqmusic / spotify' },
];

/** True the first time a task's file is fetched from this tab (also across reloads). */
function claimDelivery(id: string): boolean {
  try {
    const done = new Set<string>(JSON.parse(sessionStorage.getItem('salvia.delivered') ?? '[]'));
    if (done.has(id)) return false;
    done.add(id);
    sessionStorage.setItem('salvia.delivered', JSON.stringify([...done].slice(-200)));
    return true;
  } catch {
    return true;
  }
}

const keyOf = (items: Item[]) => items.map((i) => i.id).join('\n');


export function App() {
  const { items: allItems, tasks, status, prefs, server } = useView();
  // On a shared server, a finished download comes to this browser by itself (once per task);
  // the server drops its copy when the transfer completes.
  useEffect(() => {
    if (!server) return;
    for (const t of tasks) {
      if (t.status !== 'done' || !t.outputPath || !claimDelivery(t.id)) continue;
      const a = document.createElement('a');
      a.href = api.fileUrl(t.id);
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    }
  }, [server, tasks]);
  // @setting appearance / theme (the default theme keeps the page's own terracotta).
  useEffect(() => {
    const root = document.documentElement;
    if (!prefs || prefs.appearance === 'auto') delete root.dataset.theme;
    else root.dataset.theme = prefs.appearance;
    const dark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    if (prefs && prefs.theme !== 'salvia') root.style.setProperty('--clay', dark ? prefs.webAccentDark : prefs.webAccent);
    else root.style.removeProperty('--clay');
  }, [prefs?.theme, prefs?.appearance]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const [sel, setSel] = useState(-1);
  // Results that can't be obtained right now are hidden until the user asks for them.
  const [showLocked, setShowLocked] = useState(false);
  const [login, setLogin] = useState<Item | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  /** A detail closed before its pick finished: undo that pick's list when it lands. */
  const abandon = useRef<string | undefined>(undefined);
  const lockedCount = allItems.filter((i) => i.locked).length;
  const items = showLocked ? allItems : allItems.filter((i) => !i.locked);
  const input = useRef<HTMLInputElement>(null);
  const mode = MODES.find((m) => text.startsWith(m.cmd.trim()));

  // While an @command is typed: command names, then the values its arguments take (sites, platforms …).
  const hints = useCompletions(text, text !== sent);
  const mark = useMark(text);
  const overlay = useRef<HTMLSpanElement>(null);
  // Long text scrolls inside the input: keep the drawn text over it.
  const syncScroll = () => {
    if (overlay.current && input.current) overlay.current.scrollLeft = input.current.scrollLeft;
  };
  useEffect(syncScroll, [text, mark]);
  const [hintSel, setHintSel] = useState(0);
  useEffect(() => setHintSel(Math.max(0, hints.findIndex((h) => h.fill))), [hints]);
  const current = hints[hintSel];
  const ghost = current?.fill?.toLowerCase().startsWith(text.toLowerCase()) ? current.fill.slice(text.length).trimEnd() : '';

  // Keep the highlighted row when the list grows (streamed results); otherwise start at the first usable one.
  const selId = useRef<string | undefined>(undefined);
  // Only a change of selection updates the remembered id; a new list alone must not.
  useEffect(() => {
    selId.current = items[sel]?.id;
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const kept = items.findIndex((i) => i.id === selId.current && !i.disabled);
    setSel(kept >= 0 ? kept : items.findIndex((i) => !i.disabled));
  }, [items]);

  // Follow the list under an open detail; drop the list of a detail closed while loading.
  useEffect(() => {
    const key = keyOf(allItems);
    if (abandon.current !== undefined && key !== abandon.current) {
      abandon.current = undefined;
      void api.back();
      return;
    }
    setDetail((d) => {
      if (!d || key === d.keys[d.keys.length - 1]) return d;
      const keys = d.keys.length > 1 && d.keys[d.keys.length - 2] === key ? d.keys.slice(0, -1) : [...d.keys, key];
      return { ...d, keys };
    });
  }, [allItems]);

  const move = (d: number) => {
    let i = sel;
    for (let n = 0; n < items.length; n++) {
      i = (i + d + items.length) % items.length;
      if (!items[i]!.disabled) return setSel(i);
    }
  };

  /** A result with details: show them, with its download options in the card underneath. */
  const openDetail = (item: Item) => {
    const seq = Date.now();
    abandon.current = undefined;
    setDetail({ item, tab: 0, seq, keys: [keyOf(allItems)] });
    api.preview(item.id, true).then(
      (data) => setDetail((p) => (p?.seq === seq ? { ...p, data } : p)),
      (err: Error) => setDetail((p) => (p?.seq === seq ? { ...p, error: err.message } : p)),
    );
    input.current?.focus();
  };

  const submit = (value: string) => {
    setDetail(null);
    abandon.current = undefined;
    setSent(value.trim());
    setShowLocked(false);
    setLogin(null);
    void api.input(value);
  };

  const back = () => {
    if (!detail) {
      setText('');
      return submit('');
    }
    if (detail.keys.length > 2) return void api.back(); // one level up inside the download card
    setDetail(null);
    if (detail.keys.length > 1) void api.back();
    else abandon.current = detail.keys[0];
    input.current?.focus();
  };

  const pick = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item?.locked && (item.locked.site || !item.preview)) return setLogin(item);
    if (item?.preview && !detail) return openDetail(item);
    // Picking an offered "@novel …" row runs it as if typed, so show it in the box.
    if (item && id.startsWith('search:')) {
      setText(item.title);
      setSent(item.title);
    }
    void api.pick(id);
    input.current?.focus();
  };

  const browserLogin = (item: Item) => {
    const site = item.locked?.site;
    const cmd = site ? `@login ${site}` : '@login';
    setText(cmd);
    submit(cmd);
  };

  const pasteCookie = (item: Item) => {
    const site = item.locked?.site;
    setLogin(null);
    setText(site ? `@cookie ${site} ` : '@cookie ');
    input.current?.focus();
  };

  const chooseMode = (cmd: string) => {
    // Keep what was typed after the old command.
    const rest = text.replace(/^@\S*\s*/, '');
    setText(cmd + rest);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const caretAtEnd = e.currentTarget.selectionStart === text.length;
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && caretAtEnd)) && current?.fill && ghost) {
      e.preventDefault();
      setText(current.fill);
    } else if (hints.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const usable = hints.map((h, i) => (h.fill ? i : -1)).filter((i) => i >= 0);
      const at = usable.indexOf(hintSel);
      if (usable.length) setHintSel(usable[(at + (e.key === 'ArrowDown' ? 1 : usable.length - 1)) % usable.length]!);
    } else if (hints.length && e.key === 'Enter' && !e.nativeEvent.isComposing && current?.fill && !current.ready) {
      // Fill the highlighted completion; it runs on Enter once typed in full.
      e.preventDefault();
      setText(current.fill);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Escape') {
      back();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Enter on unchanged text picks the highlighted row; otherwise it submits.
      const item = items[sel];
      if (text.trim() !== sent) submit(text);
      else if (item && (!detail || detail.keys.length > 1)) pick(item.id);
    }
  };

  const ready = !detail || detail.keys.length > 1;
  const home = !sent && !detail;

  const list = ready && items.length > 0 && <ResultList items={items} sel={sel} onHover={setSel} onPick={pick} />;

  return (
    <div className="page">
      <header className="top">
        <button className="logo" onClick={() => (setText(''), submit(''))} aria-label="Salvia 首页">
          <i aria-hidden>❀</i>Salvia
        </button>
        <nav>
          {MODES.slice(0, 4).map((m) => (
            <button key={m.cmd} onClick={() => chooseMode(m.cmd)}>
              {m.name}
            </button>
          ))}
          {!server && (
            <button className="pill dark" onClick={() => chooseMode('@login ')}>
              登录
            </button>
          )}
        </nav>
      </header>

      <main>
        {home && (
          <section className="hero">
            <p className="eyebrow">Salvia</p>
            <h1>把喜欢的内容，留在身边</h1>
            <p>下载 B站、YouTube 视频，网易云、QQ音乐、Spotify 的音乐，和 Legado 书源里的小说。粘贴链接，或输入 @ 开始。</p>
          </section>
        )}

        <section className="prompt">
          <div className="composer">
            <label className="field">
              <span className={`ghost${mark ? ' marked' : ''}`} aria-hidden ref={overlay}>
                {/* With a known @command at the start, the text is drawn here (command coloured) over a transparent input. */}
                <span className="cmd">{text.slice(0, mark)}</span>
                <span className="typed">{text.slice(mark)}</span>
                {ghost}
              </span>
              <input
                ref={input}
                className={mark ? 'marked' : undefined}
                onScroll={syncScroll}
                onSelect={syncScroll}
                value={text}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                placeholder="粘贴链接，或输入 @ 开始（@music 晴天）"
                aria-label="@novel、@music、@video 搜索，@parse 解析链接或编号，@ 开头的其他是命令"
                onChange={(e) => {
                  setText(e.target.value);
                  // Emptying the box goes back to the home screen.
                  if (!e.target.value && (sent || detail || allItems.length || status.text)) submit('');
                }}
                onKeyDown={onKey}
              />
            </label>
            <div className="bar">
              <div className="modes" role="tablist">
                {MODES.filter((m) => !server || m.label !== 'login').map((m) => (
                  <button key={m.cmd} role="tab" aria-selected={mode?.cmd === m.cmd} onClick={() => chooseMode(m.cmd)} title={m.hint}>
                    @{m.label}
                  </button>
                ))}
                {lockedCount > 0 && (
                  <button className={`toggle${showLocked ? ' on' : ''}`} onClick={() => (setShowLocked(!showLocked), input.current?.focus())}>
                    {showLocked ? '隐藏' : '显示'}不可用 {lockedCount}
                  </button>
                )}
              </div>
              <button className="send" aria-label="执行（Enter）" disabled={!text.trim() || text.trim() === sent} onClick={() => submit(text)}>
                ↑
              </button>
            </div>
          </div>
          {hints.length > 0 && (
            <ul className="hints">
              {hints.map((c, i) => (
                <li
                  key={(c.fill ?? '') + c.title + i}
                  aria-selected={i === hintSel && !!c.fill}
                  data-hint={c.fill ? undefined : ''}
                  onMouseEnter={() => c.fill && setHintSel(i)}
                  onClick={() => c.fill && (setText(c.fill), input.current?.focus())}
                >
                  <span className="title">{c.title}</span>
                  {c.meta && <span className="meta">{c.meta}</span>}
                </li>
              ))}
              {hints.some((h) => h.fill) && <li className="keys">Tab / → 接受灰色提示 · ↑↓ 选择 · Enter 补全或执行</li>}
            </ul>
          )}
        </section>

        {(status.text || !home) && (
          <div className="statusline">
            <p className={`status ${status.tone}`} aria-live="polite">
              {status.text}
              {!showLocked && lockedCount > 0 && <span className="muted"> · 已隐藏 {lockedCount} 个需登录的结果</span>}
            </p>
            {!home && (
              <button className="pill" onClick={back}>
                ESC 返回
              </button>
            )}
          </div>
        )}

        {login && (
          <LoginCard item={login} server={!!server} onBrowser={() => browserLogin(login)} onPaste={() => pasteCookie(login)} onCancel={() => setLogin(null)} />
        )}

        {detail ? (
          <>
            <DetailPane p={detail} onTab={(tab) => setDetail({ ...detail, tab })} />
            <section className="card download">
              <header>
                <h3>下载</h3>
                {detail.data?.audio && <audio key={detail.seq} controls preload="none" src={`/api/preview/audio?v=${detail.seq}`} />}
                {!detail.data?.audio && detail.data?.note && <span className="muted">{detail.data.note}</span>}
              </header>
              {list || <p className={`status ${status.tone === 'error' ? 'error' : 'busy'}`}>{status.tone === 'error' ? status.text : '正在获取下载选项'}</p>}
            </section>
          </>
        ) : (
          list && <section className="card results">{list}</section>
        )}

        {tasks.length > 0 && (
          <section className="card tasks">
            <h3>任务</h3>
            <ul>
              {tasks.map((t) => (
                <TaskRow key={t.id} t={t} server={!!server} />
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
