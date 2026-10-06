import { Box, Text, useAnimation } from 'ink';
import { type View } from '@salvia/core';
import stringWidth from 'string-width';
import { type PreviewState } from '../state.ts';
import { ACCENT, ERR, Equalizer, ScrollText, Spinner, Tabs, fit, wrapLines } from '../widgets/index.ts';

/** Facts as "label value" pairs packed into as few lines as fit. */
function fieldLines(fields: { label: string; value: string }[], width: number): { label: string; value: string }[][] {
  const lines: { label: string; value: string }[][] = [];
  let line: { label: string; value: string }[] = [];
  let used = 0;
  for (const f of fields) {
    const value = fit(f.value, Math.max(6, width - stringWidth(f.label) - 4));
    const w = stringWidth(f.label) + 1 + stringWidth(value) + 3;
    if (line.length && used + w > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push({ label: f.label, value });
    used += w;
  }
  if (line.length) lines.push(line);
  return lines;
}

export function PlayClock({ playback }: { playback: NonNullable<View['playback']> }) {
  const playing = playback.state === 'playing';
  const { frame } = useAnimation({ interval: 250, isActive: playing });
  void frame;
  const elapsed = playing && playback.startedAt ? Math.min(playback.duration, (Date.now() - playback.startedAt) / 1000) : 0;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <Box>
      <Equalizer active={playing} />
      <Text dimColor>{playing ? `  ${mmss(elapsed)} / ${mmss(playback.duration)}` : '  缓冲中…'}</Text>
    </Box>
  );
}

/** Preview of one result: title, facts, tabbed texts (简介 / 歌词 / 章节). */
export function PreviewPanel({
  p,
  width,
  height,
  onTab,
  onScroll,
}: {
  p: PreviewState;
  width: number;
  height: number;
  onTab: (i: number) => void;
  onScroll: (top: number) => void;
}) {
  const data = p.data;
  const inner = width - 2;
  const title = fit(data?.title ?? p.row.title, Math.floor(inner * 0.6));
  const subtitle = data?.subtitle ?? p.row.meta ?? '';
  const facts = data ? fieldLines(data.fields, inner).slice(0, 3) : [];
  const sections = data?.sections ?? [];
  const tab = Math.min(p.tab, Math.max(0, sections.length - 1));
  const textRows = Math.max(1, height - 1 - facts.length - (sections.length ? 1 : 0));
  const lines = sections[tab] ? wrapLines(sections[tab]!.text, inner - 2) : [];
  const top = Math.min(p.top, Math.max(0, lines.length - textRows));

  return (
    <Box flexDirection="column" height={height} width={width} paddingLeft={1} overflow="hidden">
      <Box width={inner}>
        <Text bold color={ACCENT}>
          {title}
        </Text>
        <Text dimColor>{`  ${fit(subtitle, Math.max(0, inner - stringWidth(title) - 2))}`}</Text>
      </Box>
      {facts.map((line, i) => (
        <Box key={i} width={inner}>
          {line.map((f) => (
            <Box key={f.label} marginRight={3}>
              <Text dimColor>{f.label} </Text>
              <Text>{f.value}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {p.state === 'loading' ? (
        <Box height={height - 1}>
          <Spinner />
          <Text dimColor> 正在读取详情…</Text>
        </Box>
      ) : p.state === 'error' ? (
        <Text color={ERR}>{fit(p.error ?? '', inner)}</Text>
      ) : (
        <>
          {sections.length ? <Tabs tabs={sections.map((x) => x.title)} active={tab} width={inner} onChange={onTab} /> : null}
          <ScrollText lines={lines} top={top} height={textRows} width={inner} onScroll={onScroll} />
        </>
      )}
    </Box>
  );
}
