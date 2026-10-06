import { useEffect, useState } from 'react';

// Mirrors @salvia/core types; kept local so the browser bundle never pulls in Node code.
export type Tone = 'idle' | 'busy' | 'ok' | 'error';
export interface Item {
  id: string;
  title: string;
  meta?: string;
  disabled?: boolean;
  /** Not obtainable right now (members-only, region): hidden unless asked for; picking asks to log in. */
  locked?: { reason: string; site?: string };
  /** Details can be shown before picking (api.preview). */
  preview?: boolean;
}
export interface Preview {
  title: string;
  subtitle?: string;
  fields: { label: string; value: string }[];
  sections: { title: string; text: string }[];
  audio?: { duration?: number; note?: string };
  note?: string;
}
export interface Task {
  id: string;
  kind: string;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
  progress: number;
  speed?: number;
  error?: string;
  outputPath?: string;
}
/** @setting theme / appearance. */
export interface Prefs {
  theme: string;
  webAccent: string;
  webAccentDark: string;
  appearance: 'auto' | 'light' | 'dark';
}
export interface View {
  status: { text: string; tone: Tone };
  items: Item[];
  tasks: Task[];
  prefs?: Prefs;
  /** Served with @web:server: no logins or settings from the browser, files are saved through it. */
  server?: boolean;
}

/** A `patch` event: only the parts of the view that changed. */
interface Patch {
  list?: { items: Item[]; canBack?: boolean };
  status?: View['status'];
  tasks?: Task[];
  playback?: unknown;
  prefs?: Prefs;
}

const EMPTY: View = { status: { text: '', tone: 'idle' }, items: [], tasks: [] };

export function useView(): View {
  const [view, setView] = useState(EMPTY);
  useEffect(() => {
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // EventSource gives up for good on an HTTP error (e.g. 502 while the server restarts), so reconnect by hand.
    const connect = () => {
      es = new EventSource('/api/events');
      // The whole view once, then only the parts that changed.
      es.addEventListener('view', (e) => setView(JSON.parse((e as MessageEvent).data) as View));
      es.addEventListener('patch', (e) => {
        const p = JSON.parse((e as MessageEvent).data) as Patch;
        setView((v) => ({
          ...v,
          ...(p.list ?? {}),
          ...(p.status ? { status: p.status } : {}),
          ...(p.tasks ? { tasks: p.tasks } : {}),
          ...('playback' in p ? { playback: p.playback ?? undefined } : {}),
          ...(p.prefs ? { prefs: p.prefs } : {}),
        }));
      });
      es.onerror = () => {
        if (es?.readyState !== EventSource.CLOSED) return;
        timer = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      clearTimeout(timer);
      es?.close();
    };
  }, []);
  return view;
}

export interface CommandInfo { name: string; usage: string }

/** A completion for what is being typed: `fill` replaces the input; without it the row is a hint. */
export interface Completion { title: string; meta?: string; fill?: string; ready?: boolean }

/** Completions from the server, following the input as it changes. */
export function useCompletions(text: string, active: boolean): Completion[] {
  const [list, setList] = useState<Completion[]>([]);
  useEffect(() => {
    if (!active || !text.startsWith('@')) return setList([]);
    const ctl = new AbortController();
    fetch(`/api/complete?text=${encodeURIComponent(text)}`, { signal: ctl.signal })
      .then((r) => r.json() as Promise<Completion[]>)
      .then(setList)
      .catch(() => {});
    return () => ctl.abort();
  }, [text, active]);
  return active ? list : [];
}

/** Length of the known @command at the start of the text (shown in the theme colour), 0 for none. */
export function useMark(text: string): number {
  const [mark, setMark] = useState(0);
  useEffect(() => {
    if (!text.startsWith('@')) return setMark(0);
    const ctl = new AbortController();
    fetch(`/api/mark?text=${encodeURIComponent(text.split(/\s/)[0]!)}`, { signal: ctl.signal })
      .then((r) => r.json() as Promise<{ length: number }>)
      .then((r) => setMark(r.length))
      .catch(() => {});
    return () => ctl.abort();
  }, [text.split(/\s/)[0]]); // eslint-disable-line react-hooks/exhaustive-deps
  return text.startsWith('@') ? mark : 0;
}

export function useCommands(): CommandInfo[] {
  const [list, setList] = useState<CommandInfo[]>([]);
  useEffect(() => {
    fetch('/api/commands')
      .then((r) => r.json() as Promise<CommandInfo[]>)
      .then(setList)
      .catch(() => {});
  }, []);
  return list;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  input: (text: string) => post('/api/input', { text }),
  pick: (id: string) => post('/api/pick', { id }),
  pause: (id: string) => post(`/api/task/${id}/pause`),
  cancel: (id: string) => post(`/api/task/${id}/cancel`),
  /** Forget the task; `delete` also deletes the downloaded file. */
  remove: (id: string) => post(`/api/task/${id}/remove`),
  deleteFile: (id: string) => post(`/api/task/${id}/delete`),
  /** The finished file, downloaded by the browser. */
  fileUrl: (id: string) => `/api/task/${id}/file`,
  back: () => post('/api/back'),
  /** The result's details; `pick` also opens its download options in the list. */
  async preview(id: string, pick = false): Promise<Preview> {
    const res = await post('/api/preview', { id, pick });
    const body = (await res.json()) as Preview & { error?: string };
    if (!res.ok) throw new Error(body.error ?? '预览失败');
    return body;
  },
};
