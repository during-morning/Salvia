import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { loadConfig, saveConfig } from './config.ts';
import { database, kv } from './db.ts';
import { registry } from './registry.ts';

/** What `@setting` can change. Values are strings; numbers are parsed where they are used. */
export interface SettingDef {
  key: string;
  group: '主题' | '样式' | '偏好' | '下载';
  label: string;
  /** Allowed values, with what the UI shows for them (a getter when they depend on installed modules). Absent: free text. */
  options?: { value: string; label: string }[];
  default: string;
  hint?: string;
}

export const THEMES: Record<string, { label: string; accent: string; ok: string; web: string; webDark: string }> = {
  salvia: { label: '鼠尾草紫', accent: '#8f84f0', ok: '#7fb069', web: '#5a4bc8', webDark: '#9d92f5' },
  clay: { label: '陶土橙', accent: '#d97757', ok: '#7fb069', web: '#c46849', webDark: '#e08a6a' },
  mint: { label: '薄荷绿', accent: '#5fc4a0', ok: '#8fc46b', web: '#2f8f6e', webDark: '#6fd1ad' },
  ocean: { label: '海蓝', accent: '#5fa8f0', ok: '#7fb069', web: '#2f6fc0', webDark: '#79b4f2' },
  sakura: { label: '樱粉', accent: '#f08cb4', ok: '#7fb069', web: '#c4507f', webDark: '#f29cc0' },
  mono: { label: '黑白灰', accent: '#c8c8c8', ok: '#a8a8a8', web: '#3a3a3a', webDark: '#d0d0d0' },
};

const onOff = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
];

/** Settings every Salvia has; modules add theirs (registry `setting`), listed after these. */
const CORE_SETTINGS: SettingDef[] = [
  { key: 'theme', group: '主题', label: '主题色', default: 'salvia', options: Object.entries(THEMES).map(([value, t]) => ({ value, label: t.label })) },
  {
    key: 'appearance',
    group: '主题',
    label: '网页版外观',
    default: 'auto',
    options: [
      { value: 'auto', label: '跟随系统' },
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
    ],
  },
  {
    key: 'listStyle',
    group: '样式',
    label: '结果列表',
    default: 'table',
    options: [
      { value: 'table', label: '表格（歌名 / 歌手 / 专辑 / 时长 / 来源）' },
      { value: 'compact', label: '紧凑（标题 + 一行信息）' },
    ],
  },
  { key: 'animation', group: '样式', label: '列表动画', default: 'on', options: onOff },
  { key: 'showLocked', group: '偏好', label: '默认显示不可用的结果', default: 'off', options: onOff, hint: '需会员 / 需登录 / 地区不可用的结果' },
  {
    key: 'connections',
    group: '下载',
    label: '每个文件的连接数（多线程）',
    default: '16',
    options: ['1', '4', '8', '16', '32'].map((value) => ({ value, label: `${value} 线程` })),
  },
  {
    key: 'concurrency',
    group: '下载',
    label: '同时下载的任务数',
    default: '3',
    options: ['1', '2', '3', '4', '6', '8'].map((value) => ({ value, label: `${value} 个` })),
  },
  { key: 'downloadDir', group: '下载', label: '下载目录', default: '', hint: '@setting downloadDir <路径>' },
];

export const settingEvents = new EventEmitter<{ change: [key: string, value: string] }>();
// Every session listens (one per browser in server mode).
settingEvents.setMaxListeners(0);

/** Every setting: core's, then the modules' (grouped as the modules registered them). */
export function allSettings(): SettingDef[] {
  const order = ['主题', '样式', '偏好', '下载'];
  return [...CORE_SETTINGS, ...registry.settings].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

export function settingDef(key: string): SettingDef | undefined {
  const k = key.toLowerCase();
  return allSettings().find((s) => s.key.toLowerCase() === k || s.label === key);
}

/** Stored values, read once per database (views ask for them on every redraw). */
let cache: { db: unknown; values: Map<string, string | undefined> } | undefined;

function stored(key: string): string | undefined {
  const db = database();
  if (cache?.db !== db) cache = { db, values: new Map() };
  if (!cache.values.has(key)) cache.values.set(key, kv.get<string>(`setting.${key}`));
  return cache.values.get(key);
}

export function getSetting(key: string): string {
  // These two live in the config (older versions and @dir write them there).
  if (key === 'downloadDir') return loadConfig().downloadDir;
  if (key === 'concurrency') return String(loadConfig().concurrency);
  const def = settingDef(key);
  try {
    const v = stored(key);
    if (v !== undefined && (!def?.options || def.options.some((o) => o.value === v))) return v;
  } catch {
    // no database: defaults
  }
  return def?.default ?? '';
}

export const settingOn = (key: string) => getSetting(key) === 'on';
export const settingNumber = (key: string) => Number(getSetting(key)) || Number(settingDef(key)?.default) || 0;

/** Validates and stores; returns an error message instead of throwing. */
export function setSetting(key: string, value: string): string | undefined {
  const def = settingDef(key);
  if (!def) return `没有设置项"${key}"。`;
  let v = value.trim();
  if (def.options) {
    const opt = def.options.find((o) => o.value === v || o.label === v || o.label.startsWith(v));
    if (!opt) return `${def.label}可以是：${def.options.map((o) => `${o.value}（${o.label}）`).join('、')}`;
    v = opt.value;
  } else if (!v) return `${def.label}不能为空。`;
  if (def.key === 'downloadDir') saveConfig({ downloadDir: (v = resolve(v)) });
  else if (def.key === 'concurrency') saveConfig({ concurrency: Number(v) });
  else {
    kv.set(`setting.${def.key}`, v);
    cache?.values.set(def.key, v);
  }
  settingEvents.emit('change', def.key, v);
  return undefined;
}

/** The label of a setting's current value. */
export function settingLabel(def: SettingDef): string {
  const v = getSetting(def.key);
  return def.options?.find((o) => o.value === v)?.label ?? v;
}

/** What the UIs style themselves with. */
export function uiPrefs() {
  const theme = THEMES[getSetting('theme')] ?? THEMES.salvia!;
  return {
    theme: getSetting('theme'),
    accent: theme.accent,
    ok: theme.ok,
    webAccent: theme.web,
    webAccentDark: theme.webDark,
    appearance: getSetting('appearance') as 'auto' | 'light' | 'dark',
    table: getSetting('listStyle') !== 'compact',
    animation: settingOn('animation'),
    showLocked: settingOn('showLocked'),
  };
}
export type UiPrefs = ReturnType<typeof uiPrefs>;
