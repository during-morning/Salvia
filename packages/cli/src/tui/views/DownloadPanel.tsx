import { Box, Text } from 'ink';
import { type Task } from '@salvia/core';
import { formatSpeed } from '../../format.ts';
import { FINAL, formatEta } from '../state.ts';
import { TaskLine } from './TaskLine.tsx';
import { ACCENT, Button, ERR, OK, ProgressBar, Rule, Sparkline, fit } from '../widgets/index.ts';

export function DownloadPanel({
  tasks,
  width,
  height,
  started,
  buttons,
  focus,
  selected,
  onTask,
  speeds,
}: {
  tasks: Task[];
  width: number;
  height: number;
  started: number;
  buttons: { label: string; onPress: () => void }[];
  focus: number;
  selected: number;
  onTask: (t: Task) => void;
  speeds: number[];
}) {
  const done = tasks.filter((t) => FINAL.has(t.status)).length;
  const known = tasks.filter((t) => t.progress >= 0 || FINAL.has(t.status));
  const overall = known.length ? known.reduce((a, t) => a + (FINAL.has(t.status) ? 1 : t.progress), 0) / tasks.length : -1;
  const speed = tasks.reduce((a, t) => a + (t.status === 'running' ? (t.speed ?? 0) : 0), 0);
  const elapsed = (Date.now() - started) / 1000;
  const eta = overall > 0.02 && overall < 1 ? (elapsed * (1 - overall)) / overall : NaN;
  const paused = tasks.some((t) => t.status === 'paused') && !tasks.some((t) => t.status === 'running');
  const barWidth = Math.max(10, width - 32);
  const listRows = Math.max(0, height - 7);
  const current = tasks.find((t) => t.status === 'running') ?? tasks.find((t) => !FINAL.has(t.status)) ?? tasks[0];
  // Keep the selected task in view.
  const first = Math.max(0, Math.min(selected - listRows + 1, tasks.length - listRows));

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Rule title="下载" detail={`${done}/${tasks.length} 完成${paused ? ' · 已暂停' : ''}`} busy={!paused} width={width} />
      <Box paddingLeft={1}>
        <Text bold>{fit(current?.title ?? '', width - 2)}</Text>
      </Box>
      <Box paddingLeft={1}>
        <ProgressBar value={overall} width={barWidth} dim={paused} />
        <Text>{`  ${overall >= 0 ? `${Math.round(overall * 100)}%`.padStart(4) : ''}`}</Text>
        <Text dimColor>{`  ${speed ? formatSpeed(speed) : ''}${eta ? `  剩余 ${formatEta(eta)}` : ''}`}</Text>
      </Box>
      <Box paddingLeft={1} height={1}>
        {speeds.some((v) => v > 0) ? (
          <>
            <Sparkline values={speeds} width={barWidth} />
            <Text dimColor>{`  峰值 ${formatSpeed(Math.max(...speeds))}`}</Text>
          </>
        ) : null}
      </Box>
      <Box paddingLeft={1} marginY={1}>
        {buttons.map((b, i) => (
          <Button key={b.label} label={b.label} onPress={b.onPress} focused={i === focus} />
        ))}
      </Box>
      {tasks.length > 1 && (
        <Box flexDirection="column" height={listRows} overflow="hidden">
          {tasks.slice(first, first + listRows).map((t, i) => {
            const icon = t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : t.status === 'canceled' ? '–' : t.status === 'paused' ? '‖' : t.status === 'queued' ? '·' : '↓';
            const color = t.status === 'done' ? OK : t.status === 'error' ? ERR : t.status === 'running' ? ACCENT : 'gray';
            const right = t.status === 'running' ? `${Math.round(Math.max(0, t.progress) * 100)}%` : t.status === 'error' ? (t.error ?? '失败') : '';
            return (
              <TaskLine key={t.id} width={width} selected={first + i === selected} onPress={() => onTask(t)}>
                <Text color={color}>{`${icon} `}</Text>
                <Text dimColor={FINAL.has(t.status)}>{fit(t.title, width - 17)}</Text>
                <Text dimColor>{`  ${fit(right, 10)}`}</Text>
              </TaskLine>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
