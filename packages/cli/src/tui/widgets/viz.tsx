import { Text, useAnimation } from 'ink';
import { ACCENT } from './theme.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ active = true, color = ACCENT }: { active?: boolean; color?: string }) {
  const { frame } = useAnimation({ interval: 80, isActive: active });
  return <Text color={color}>{active ? FRAMES[frame % FRAMES.length] : ' '}</Text>;
}

/** `value` 0..1, or < 0 for "unknown" (a block sweeping back and forth). */
export function ProgressBar({ value, width, color = ACCENT, dim = false }: { value: number; width: number; color?: string; dim?: boolean }) {
  const { frame } = useAnimation({ interval: 60, isActive: value < 0 });
  const w = Math.max(4, width);
  if (value < 0) {
    const block = Math.max(2, Math.floor(w / 6));
    const span = w - block;
    const pos = span ? Math.abs((frame % (span * 2)) - span) : 0;
    return (
      <Text>
        <Text dimColor>{'─'.repeat(pos)}</Text>
        <Text color={color}>{'━'.repeat(block)}</Text>
        <Text dimColor>{'─'.repeat(w - pos - block)}</Text>
      </Text>
    );
  }
  const filled = Math.round(Math.min(1, Math.max(0, value)) * w);
  return (
    <Text>
      <Text color={dim ? 'gray' : color}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(w - filled)}</Text>
    </Text>
  );
}

// ---------- Button ----------

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Bouncing bars while audio plays. */
export function Equalizer({ active, bars = 5 }: { active: boolean; bars?: number }) {
  const { time } = useAnimation({ interval: 90, isActive: active });
  const out = Array.from({ length: bars }, (_, i) => {
    if (!active) return BARS[0];
    const v = (Math.sin(time / 140 + i * 1.7) + Math.sin(time / 230 + i * 0.9) + 2) / 4;
    return BARS[Math.min(7, Math.floor(v * 8))];
  }).join('');
  return <Text color={ACCENT}>{out}</Text>;
}

// ---------- Sparkline ----------

/** Recent values as ▁▂▃▅▇ (e.g. download speed). */
export function Sparkline({ values, width }: { values: number[]; width: number }) {
  const shown = values.slice(-width);
  const max = Math.max(1, ...shown);
  return (
    <Text color={ACCENT}>
      {shown.map((v) => BARS[Math.min(7, Math.round((v / max) * 7))]).join('').padStart(width, ' ')}
    </Text>
  );
}

// ---------- Toast ----------
