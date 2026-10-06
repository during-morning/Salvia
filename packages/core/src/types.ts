import type { UiPrefs } from './settings.ts';

export type IntentKind =
  | 'video'
  | 'music'
  | 'video-search'
  | 'music-search'
  | 'novel-search'
  | 'anime-search'
  | 'command'
  /** Plain text without `@`: the UI offers the searches to choose from. */
  | 'text'
  | 'empty';

export interface Intent {
  kind: IntentKind;
  /** URL, keyword or command line, already trimmed and with prefixes removed. */
  input: string;
  /** Provider hint for URL intents, e.g. 'bilibili', 'youtube', 'netease'. */
  site?: string;
  /** `@music:qq-music …`: search only this platform (canonical id; for novels a book-source name). */
  platform?: string;
}

export type Tone = 'idle' | 'busy' | 'ok' | 'error';

export interface Status {
  text: string;
  tone: Tone;
}

/** A pickable row under the input. Serializable; the pick action lives in the session. */
export interface Item {
  id: string;
  title: string;
  meta?: string;
  disabled?: boolean;
  /**
   * Not obtainable as things stand (members-only, region, removed). Hidden by default in the UIs;
   * shown on request, and picking one asks the user to log in to `site`.
   */
  locked?: { reason: string; site?: string };
  /** Session.preview(id) can show details (intro, lyrics, stats, first chapters) before picking. */
  preview?: boolean;
  /** One value per `View.columns` entry, for table views. Rows without cells span the table. */
  cells?: string[];
  /** Can be checked for the list's batch action (Session.pickMany). */
  selectable?: boolean;
}

/** A table column. `flex` columns share the room left after the fixed ones. */
export interface Column {
  title: string;
  /** Fixed width in terminal cells. */
  width?: number;
  /** Share of the remaining width (default 1). */
  flex?: number;
  align?: 'left' | 'right';
}

/** Details shown before downloading. */
export interface Preview {
  title: string;
  subtitle?: string;
  /** Short facts: 时长、播放、点赞、作者… */
  fields: { label: string; value: string }[];
  /** Long texts, one tab each: 简介、歌词、第一章… */
  sections: { title: string; text: string }[];
  /** A clip can be played with Session.play(); absent when none is available. */
  audio?: { duration?: number; note?: string };
  /** Why something is missing (e.g. 试听不可用). */
  note?: string;
}

/** Where a preview clip comes from (kept in the session; not sent to clients). */
export interface AudioClip {
  url: string;
  headers?: Record<string, string>;
  /** Seconds into the stream to start at. */
  start?: number;
  /** Seconds to play (default 30). */
  duration?: number;
}

export interface Playback {
  title: string;
  state: 'loading' | 'playing';
  /** ms epoch when sound started. */
  startedAt?: number;
  /** seconds */
  duration: number;
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled';

export interface Task {
  id: string;
  kind: string;
  title: string;
  status: TaskStatus;
  /** 0..1, or -1 when unknown. */
  progress: number;
  /** bytes per second */
  speed?: number;
  error?: string;
  outputPath?: string;
}

export interface View {
  status: Status;
  items: Item[];
  tasks: Task[];
  /** A previous list exists (Session.back()). */
  canBack?: boolean;
  /** A preview clip that is loading or playing. */
  playback?: Playback;
  /** The list is a table with these columns. */
  columns?: Column[];
  /** Checked rows can be acted on together (Session.pickMany), e.g. "下载选中". */
  batch?: { label: string };
  /** Theme and list preferences from @setting. */
  prefs?: UiPrefs;
}

export interface Progress {
  progress: number;
  speed?: number;
}
