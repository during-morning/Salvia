import { Box, Text } from 'ink';
import { type View } from '@salvia/core';
import { type Row, type PreviewState } from '../state.ts';
import { PlayClock, PreviewPanel } from './PreviewPanel.tsx';
import { ACCENT, Button, ERR, ListView, Rule, Spinner, fit } from '../widgets/index.ts';

/** The detail screen: preview on top; 试听 and the download options in a framed box below. */
export function DetailView({
  p,
  width,
  detailHeight,
  boxHeight,
  playback,
  status,
  rows,
  selected,
  hidden,
  onTab,
  onScroll,
  onPlay,
  onBack,
  onSelect,
  onActivate,
}: {
  p: PreviewState;
  width: number;
  detailHeight: number;
  boxHeight: number;
  playback: View['playback'];
  status: View['status'];
  rows: Row[];
  selected: number;
  hidden: number;
  onTab: (i: number) => void;
  onScroll: (top: number) => void;
  onPlay: () => void;
  onBack: () => void;
  onSelect: (i: number) => void;
  onActivate: (i: number) => void;
}) {
  const ready = p.keys.length > 1;
  const inner = width - 4;
  const audio = p.data?.audio;
  const note = p.data?.note;
  // Box rows: border (2) + header line, the rest is the option list.
  const listH = Math.max(1, boxHeight - 3);
  const info = [ready ? status.text : '', hidden ? `已隐藏 ${hidden} 个需登录的选项（Ctrl+T）` : ''].filter(Boolean).join(' · ');
  return (
    <Box flexDirection="column" width={width}>
      <Rule title="详情" detail={p.data?.subtitle ?? ''} width={width} action={{ label: 'ESC 返回', onPress: onBack }} />
      <PreviewPanel p={p} width={width} height={detailHeight} onTab={onTab} onScroll={onScroll} />
      <Box borderStyle="round" borderColor={ACCENT} width={width} height={boxHeight} flexDirection="column" paddingX={1}>
        <Box width={inner} height={1}>
          <Text bold color={ACCENT}>
            下载{' '}
          </Text>
          {audio ? (
            <>
              <Button label={playback ? '■ 停止试听' : '▶ 试听'} onPress={onPlay} focused={!!playback} />
              {playback ? <PlayClock playback={playback} /> : <Text dimColor>Space</Text>}
            </>
          ) : (
            <Text dimColor>{fit(note ?? '', Math.max(0, inner - 6))}</Text>
          )}
          {info && (audio || !note) ? <Text dimColor>{`  ${fit(info, Math.max(0, inner - 8 - (audio ? 26 : 0)))}`}</Text> : null}
        </Box>
        {ready && rows.length ? (
          <ListView items={rows} selected={selected} height={listH} width={inner} focused onSelect={onSelect} onActivate={onActivate} />
        ) : status.tone === 'busy' || !ready ? (
          status.tone === 'error' ? (
            <Text color={ERR}>{fit(status.text, inner)}</Text>
          ) : (
            <Box>
              <Spinner />
              <Text dimColor>{` ${fit(status.text || '正在获取下载选项', inner - 2)}`}</Text>
            </Box>
          )
        ) : (
          <Text color={status.tone === 'error' ? ERR : 'gray'}>{fit(status.text || '没有下载选项。', inner)}</Text>
        )}
      </Box>
    </Box>
  );
}
