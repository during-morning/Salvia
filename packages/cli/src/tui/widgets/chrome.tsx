import { useRef, useState } from 'react';
import { Box, Text, useAnimation, type DOMElement } from 'ink';
import { useMouseArea } from '../hit.tsx';
import stringWidth from 'string-width';
import { fit, graphemes, padEnd } from './text.ts';
import { ACCENT, ERR, OK } from './theme.ts';
import { Spinner } from './viz.tsx';

export function Button({
  label,
  onPress,
  focused = false,
  disabled = false,
  layer,
}: {
  label: string;
  onPress: () => void;
  focused?: boolean;
  disabled?: boolean;
  layer?: number;
}) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, {
    layer,
    onClick: () => !disabled && onPress(),
    onHover: () => setHover(true),
    onLeave: () => setHover(false),
  });
  const active = !disabled && (focused || hover);
  return (
    <Box ref={ref} marginRight={2}>
      <Text inverse={active} color={disabled ? 'gray' : active ? ACCENT : undefined} bold={focused}>
        {`[ ${label} ]`}
      </Text>
    </Box>
  );
}

// ---------- Toggle (bordered, sits next to the input box) ----------

export function Toggle({ label, on, width, onPress }: { label: string; on: boolean; width: number; onPress: () => void }) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, {
    onClick: onPress,
    onHover: () => setHover(true),
    onLeave: () => setHover(false),
  });
  const active = on || hover;
  return (
    <Box ref={ref} borderStyle="round" borderColor={active ? ACCENT : 'gray'} width={width} height={3} justifyContent="center">
      <Text color={active ? ACCENT : 'gray'} inverse={hover}>
        {fit(label, width - 2)}
      </Text>
    </Box>
  );
}

// ---------- Section rule ----------

/** `─ 标题  detail ─────────────` across the full width. */
export function Rule({
  title,
  detail,
  width,
  busy,
  tone,
  action,
}: {
  title: string;
  detail?: string;
  width: number;
  busy?: boolean;
  tone?: 'error' | 'ok';
  /** A clickable label at the right end, e.g. "ESC 返回". */
  action?: { label: string; onPress: () => void };
}) {
  const head = `─ ${title} `;
  // " [ label ] ─"
  const actionWidth = action ? stringWidth(action.label) + 7 : 0;
  const room = width - stringWidth(head) - 4 - actionWidth;
  const text = detail ? fit(detail, Math.max(0, room)) : '';
  const tail = Math.max(1, width - stringWidth(head) - stringWidth(text) - 3 - actionWidth);
  return (
    <Box width={width}>
      <Text dimColor>─ </Text>
      <Text bold>{title} </Text>
      {busy ? <Spinner /> : <Text color={ACCENT}>❀</Text>}
      <Text color={tone === 'error' ? ERR : tone === 'ok' ? OK : 'gray'}> {text} </Text>
      <Text dimColor>{'─'.repeat(tail)}</Text>
      {action ? <RuleAction label={action.label} onPress={action.onPress} /> : null}
    </Box>
  );
}

function RuleAction({ label, onPress }: { label: string; onPress: () => void }) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, { onClick: onPress, onHover: () => setHover(true), onLeave: () => setHover(false) });
  return (
    <Box ref={ref}>
      <Text dimColor> </Text>
      <Text color={ACCENT} inverse={hover} bold>{`[ ${label} ]`}</Text>
      <Text dimColor> ─</Text>
    </Box>
  );
}

// ---------- TextInput ----------

/**
 * Modal box centered in the area it replaces. It takes the place of the content behind it instead
 * of floating over it: a terminal overlay leaves the cells it doesn't paint showing through (and
 * splits wide CJK characters at its edges). Mouse areas outside it are inert while it is open.
 */
export function Dialog({
  title,
  message,
  buttons,
  focus,
  width: areaWidth,
  height,
}: {
  title: string;
  message: string;
  buttons: { label: string; onPress: () => void }[];
  focus: number;
  width: number;
  height: number;
}) {
  const buttonsWidth = buttons.reduce((w, b) => w + stringWidth(b.label) + 6, 0);
  const width = Math.min(areaWidth - 4, Math.max(36, buttonsWidth + 6, Math.min(64, stringWidth(message) + 6)));
  return (
    <Box width={areaWidth} height={height} justifyContent="center" alignItems="center" flexShrink={0}>
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={2} width={width}>
        <Text bold color={ACCENT}>
          {title}
        </Text>
        <Box marginY={1}>
          <Text wrap="wrap">{message}</Text>
        </Box>
        <Box>
          {buttons.map((b, i) => (
            <Button key={b.label} label={b.label} onPress={b.onPress} focused={i === focus} layer={1} />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// ---------- Key hints ----------

export interface Hint {
  keys: string;
  label: string;
  onPress?: () => void;
}

function HintItem({ hint }: { hint: Hint }) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, {
    onClick: () => hint.onPress?.(),
    onHover: () => setHover(true),
    onLeave: () => setHover(false),
  });
  return (
    <Box ref={ref} marginRight={2}>
      <Text inverse={hover && !!hint.onPress} color={hover && hint.onPress ? ACCENT : 'gray'}>
        <Text bold>{hint.keys}</Text> {hint.label}
      </Text>
    </Box>
  );
}

/**
 * Bottom bar of key hints; the ones with an action are clickable. Never wraps: on narrow screens
 * the right-hand note goes first, then hints from the end.
 */
export function KeyHints({
  hints,
  width,
  right,
  toast,
}: {
  hints: Hint[];
  width: number;
  right?: string;
  /** Replaces the right-hand note while shown; a new `id` replays the slide-in. */
  toast?: { id: number; text: string; tone: 'ok' | 'error' | 'info' };
}) {
  const cost = (h: Hint) => stringWidth(h.keys) + 1 + stringWidth(h.label) + 2;
  const shown: Hint[] = [];
  let used = 0;
  for (const h of hints) {
    if (used + cost(h) > width) break;
    shown.push(h);
    used += cost(h);
  }
  const showRight = right && used + stringWidth(right) + 1 <= width;
  return (
    <Box width={width} height={1} justifyContent="space-between" overflow="hidden">
      <Box>
        {shown.map((h) => (
          <HintItem key={h.keys + h.label} hint={h} />
        ))}
      </Box>
      {toast ? (
        <Toast key={toast.id} text={toast.text} tone={toast.tone} width={Math.max(8, width - used - 1)} />
      ) : showRight ? (
        <Text dimColor>{right}</Text>
      ) : null}
    </Box>
  );
}

// ---------- Text wrapping ----------

/** A row of tabs; the active one is underlined in the accent colour. Click to switch. */
export function Tabs({ tabs, active, width, onChange }: { tabs: string[]; active: number; width: number; onChange: (i: number) => void }) {
  // Show a window of tabs around the active one when they don't all fit.
  const cost = (t: string) => stringWidth(t) + 4;
  let first = 0;
  while (first < active && tabs.slice(first, active + 1).reduce((a, t) => a + cost(t), 0) > width - 4) first++;
  const shown: number[] = [];
  let used = first ? 2 : 0;
  for (let i = first; i < tabs.length && used + cost(tabs[i]!) <= width - 2; i++) {
    shown.push(i);
    used += cost(tabs[i]!);
  }
  const more = shown.length && shown[shown.length - 1]! < tabs.length - 1;
  return (
    <Box width={width} height={1}>
      {first ? <Text dimColor>‹ </Text> : null}
      {shown.map((i) => (
        <Tab key={i} label={tabs[i]!} active={i === active} onPress={() => onChange(i)} />
      ))}
      {more ? <Text dimColor>›</Text> : null}
    </Box>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, { onClick: onPress, onHover: () => setHover(true), onLeave: () => setHover(false) });
  return (
    <Box ref={ref} marginRight={2}>
      <Text color={active ? ACCENT : hover ? undefined : 'gray'} bold={active} underline={active} inverse={hover && !active}>
        {` ${label} `}
      </Text>
    </Box>
  );
}

// ---------- ScrollText ----------

/** Wrapped text in a fixed-height window with a scrollbar; the wheel scrolls it. */
export function ScrollText({ lines, top, height, width, onScroll }: { lines: string[]; top: number; height: number; width: number; onScroll: (top: number) => void }) {
  const ref = useRef<DOMElement>(null);
  const rows = Math.max(1, height);
  const max = Math.max(0, lines.length - rows);
  const first = Math.max(0, Math.min(top, max));
  useMouseArea(ref, { onWheel: (dir) => onScroll(Math.max(0, Math.min(max, first + dir * 3))) });
  const scroll = lines.length > rows;
  const thumb = Math.max(1, Math.round((rows * rows) / Math.max(rows, lines.length)));
  const thumbTop = scroll ? Math.round((first / Math.max(1, max)) * (rows - thumb)) : 0;
  return (
    <Box ref={ref} flexDirection="column" height={rows} width={width}>
      {Array.from({ length: rows }, (_, k) => (
        <Box key={k} width={width}>
          <Text>{padEnd(lines[first + k] ?? '', width - 2)}</Text>
          {scroll ? <Text dimColor>{k >= thumbTop && k < thumbTop + thumb ? ' ┃' : ' │'}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

// ---------- Equalizer ----------

/** A short notice that slides in from the right of the bottom bar. */
export function Toast({ text, tone, width }: { text: string; tone: 'ok' | 'error' | 'info'; width: number }) {
  const { frame } = useAnimation({ interval: 16 });
  const full = `${tone === 'ok' ? '✓' : tone === 'error' ? '✗' : '•'} ${text}`;
  const shown = fit(full, width);
  const total = stringWidth(shown);
  // Slide in: reveal from the left edge of the text over ~200 ms.
  const visible = Math.min(total, Math.ceil((frame + 1) * (total / 12)));
  let out = '';
  for (const g of graphemes(shown)) {
    if (stringWidth(out + g) > visible) break;
    out += g;
  }
  return (
    <Text color={tone === 'ok' ? OK : tone === 'error' ? ERR : ACCENT} bold>
      {' '.repeat(Math.max(0, total - stringWidth(out))) + out}
    </Text>
  );
}
