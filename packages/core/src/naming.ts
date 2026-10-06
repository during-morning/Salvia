const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Make a string safe as a file name on Windows, macOS and Linux. */
export function safeName(name: string, max = 150): string {
  let s = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > max) s = s.slice(0, max).trim();
  return s || 'untitled';
}

/** Fill `{key}` placeholders, sanitizing each value. */
export function template(pattern: string, values: Record<string, string | number | undefined>): string {
  return safeName(pattern.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? '').trim()));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 245 → 4:05, 3725 → 1:02:05 */
export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
