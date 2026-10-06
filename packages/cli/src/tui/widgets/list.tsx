import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useMouseArea } from '../hit.tsx';
import stringWidth from 'string-width';
import { fit, padEnd } from './text.ts';
import { ACCENT, ANIMATE, ERR, OK } from './theme.ts';

export interface ListItem {
  id: string;
  title: string;
  meta?: string;
  disabled?: boolean;
  /** 'locked': selectable but not obtainable right now (shown dimmed). */
  tone?: 'ok' | 'error' | 'busy' | 'locked';
  /** Table cells (see ListView `columns`); rows without them span the table. */
  cells?: string[];
  /** Can be checked for the list's batch action. */
  selectable?: boolean;
}

export interface TableColumn {
  title: string;
  width?: number;
  flex?: number;
  align?: 'left' | 'right';
}

/** Widths for `columns` in `width` cells, with one space between columns. */
export function columnWidths(columns: TableColumn[], width: number): number[] {
  const gaps = columns.length - 1;
  const fixed = columns.reduce((a, c) => a + (c.width ?? 0), 0);
  const flexTotal = columns.reduce((a, c) => a + (c.width ? 0 : (c.flex ?? 1)), 0);
  const room = Math.max(0, width - fixed - gaps);
  const widths = columns.map((c) => c.width ?? Math.floor((room * (c.flex ?? 1)) / Math.max(1, flexTotal)));
  // Give the rounding leftovers to the first flexible column.
  const used = widths.reduce((a, w) => a + w, 0) + gaps;
  const firstFlex = columns.findIndex((c) => !c.width);
  if (firstFlex >= 0) widths[firstFlex]! += Math.max(0, width - used);
  return widths;
}

function cell(text: string, w: number, align: 'left' | 'right' = 'left'): string {
  const t = fit(text, w);
  const pad = ' '.repeat(Math.max(0, w - stringWidth(t)));
  return align === 'right' ? pad + t : t + pad;
}

/**
 * Scrollable list. Mouse: hover highlights, click activates, wheel scrolls. Keyboard is handled by
 * the screen, which owns `selected`.
 */
export function ListView({
  items,
  selected,
  height,
  width,
  focused,
  onSelect,
  onActivate,
  empty,
  columns,
  checked,
  onToggle,
}: {
  items: ListItem[];
  selected: number;
  height: number;
  width: number;
  focused: boolean;
  onSelect: (i: number) => void;
  onActivate: (i: number) => void;
  empty?: ReactNode;
  /** Show rows with cells as a table under a header row. */
  columns?: TableColumn[];
  /** Checked row ids (lists with a batch action): rows show [*] / [ ] for that, not the cursor. */
  checked?: Set<string>;
  onToggle?: (i: number) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const top = useRef(0);
  const table = !!columns?.length && items.some((it) => it.cells);
  const rows = Math.max(1, height - (table ? 1 : 0));
  // A new list rolls in from the top (a few rows per frame); streamed additions just appear.
  const key = items[0]?.id ?? '';
  const prevKey = useRef(key);
  const [revealed, setRevealed] = useState(Infinity);
  useLayoutEffect(() => {
    // A resize mid-animation restarts this effect: just show everything.
    if (key === prevKey.current || !key || !ANIMATE) {
      prevKey.current = key;
      setRevealed(Infinity);
      return;
    }
    prevKey.current = key;
    setRevealed(1);
    const timer = setInterval(() => {
      setRevealed((r) => {
        if (r + 3 > rows) {
          clearInterval(timer);
          return Infinity;
        }
        return r + 3;
      });
    }, 16);
    return () => clearInterval(timer);
  }, [key, rows]);
  // Keep the selection in view.
  if (selected >= 0) {
    if (selected < top.current) top.current = selected;
    if (selected >= top.current + rows) top.current = selected - rows + 1;
  }
  top.current = Math.max(0, Math.min(top.current, Math.max(0, items.length - rows)));
  const first = top.current;
  const visible = items.slice(first, first + rows);
  const scroll = items.length > rows;
  const rowWidth = width - (scroll ? 2 : 1);

  const usable = (i: number) => i >= 0 && i < items.length && !items[i]!.disabled;
  useMouseArea(ref, {
    onHover: (local) => {
      const i = first + local.y - (table ? 1 : 0);
      if (usable(i) && i !== selected) onSelect(i);
    },
    onClick: (local) => {
      const i = first + local.y - (table ? 1 : 0);
      // The checkbox column toggles; the rest of the row opens it.
      if (checked && onToggle && local.x < 4 && items[i]?.selectable) return onToggle(i);
      if (usable(i)) onActivate(i);
    },
    onWheel: (dir) => {
      let i = Math.max(0, Math.min(items.length - 1, (selected < 0 ? 0 : selected) + dir * 3));
      while (i > 0 && i < items.length - 1 && !usable(i)) i += dir;
      if (usable(i)) onSelect(i);
      else top.current = Math.max(0, top.current + dir * 3);
    },
  });

  // Scrollbar thumb position and size.
  const thumb = Math.max(1, Math.round((rows * rows) / Math.max(rows, items.length)));
  const thumbTop = scroll ? Math.round((first / Math.max(1, items.length - rows)) * (rows - thumb)) : 0;

  const widths = table ? columnWidths(columns!, rowWidth - 4) : [];

  return (
    <Box ref={ref} flexDirection="column" height={rows + (table ? 1 : 0)} width={width}>
      {table ? (
        <Box width={width}>
          <Text backgroundColor={ACCENT} color="black" bold>
            {checked ? '[选]' : '    '}
          </Text>
          {columns!.map((c, n) => (
            <Text key={c.title} backgroundColor={ACCENT} color="black" bold>
              {` ${cell(c.title, widths[n]!, c.align)}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {!items.length && empty}
      {visible.map((it, k) => {
        const i = first + k;
        if (k > revealed) return <Box key={it.id} width={width} height={1} />;
        const sel = i === selected;
        const dim = it.disabled || it.tone === 'locked';
        const color = dim ? 'gray' : it.tone === 'error' ? ERR : it.tone === 'ok' ? OK : undefined;
        const rowColor = sel && focused ? ACCENT : color;
        // With a batch action the box is the check state and the cursor is the colour; otherwise
        // the box marks the cursor.
        const box = checked ? (
          it.selectable ? (
            <Text color={checked.has(it.id) ? OK : sel && focused ? ACCENT : 'gray'} bold={checked.has(it.id)}>
              {checked.has(it.id) ? '[*] ' : '[ ] '}
            </Text>
          ) : (
            <Text color={sel && focused ? ACCENT : 'gray'}>{sel ? ' ›  ' : '    '}</Text>
          )
        ) : sel ? (
          <Text color={ACCENT} bold={focused} dimColor={!focused}>
            {'[*] '}
          </Text>
        ) : (
          <Text dimColor>{it.disabled ? '    ' : '[ ] '}</Text>
        );
        const bar = scroll ? <Text dimColor>{k >= thumbTop && k < thumbTop + thumb ? ' ┃' : ' │'}</Text> : null;
        if (table && it.cells) {
          return (
            <Box key={it.id} width={width}>
              {box}
              {columns!.map((c, n) => (
                <Text key={c.title} color={rowColor} bold={sel} dimColor={dim || (n > 0 && !sel)}>
                  {(n ? ' ' : '') + cell(it.cells![n] ?? '', widths[n]!, c.align)}
                </Text>
              ))}
              {bar}
            </Box>
          );
        }
        const metaWidth = it.meta ? Math.min(stringWidth(it.meta), Math.floor(rowWidth * 0.45)) : 0;
        const titleWidth = rowWidth - 4 - (metaWidth ? metaWidth + 2 : 0);
        return (
          <Box key={it.id} width={width}>
            {box}
            <Text color={rowColor} bold={sel} dimColor={dim}>
              {padEnd(fit(it.title, titleWidth), titleWidth)}
            </Text>
            {metaWidth ? <Text dimColor>{`  ${padEnd(fit(it.meta!, metaWidth), metaWidth)}`}</Text> : null}
            {bar}
          </Box>
        );
      })}
    </Box>
  );
}

// ---------- Dialog ----------
