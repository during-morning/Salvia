import stringWidth from 'string-width';

const seg = new Intl.Segmenter();

export function graphemes(s: string): string[] {
  return [...seg.segment(s)].map((g) => g.segment);
}

/** Cut to at most `width` cells, ending with … when shortened. */
export function fit(s: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = stringWidth(g);
    if (w + gw > width - 1) break;
    out += g;
    w += gw;
  }
  return `${out}…`;
}

export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - stringWidth(s)));
}

// ---------- Spinner / ProgressBar ----------

/** Hard-wrap `text` to `width` cells (CJK-aware), keeping its own line breaks. */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(4, width);
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    let used = 0;
    for (const g of graphemes(para)) {
      const gw = stringWidth(g);
      if (used + gw > w) {
        out.push(line);
        line = '';
        used = 0;
        if (g === ' ') continue;
      }
      line += g;
      used += gw;
    }
    out.push(line);
  }
  return out;
}

// ---------- Tabs ----------
