// Salvia: violet-blue spikes over leaf green.
// Theme colours (@setting theme); live bindings, so a change shows on the next render.
export let ACCENT = '#8f84f0';

export let OK = '#7fb069';

/** List rows roll in (@setting animation). */
export let ANIMATE = true;

export function applyTheme(accent: string, ok: string, animate: boolean): void {
  ACCENT = accent;
  OK = ok;
  ANIMATE = animate;
}

export const ERR = 'red';

// ---------- text helpers (display width aware: CJK = 2 cells) ----------
