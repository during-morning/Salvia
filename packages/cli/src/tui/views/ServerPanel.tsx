import { Box, Text } from 'ink';
import type { Status } from '@salvia/core';
import { formatSpeed } from '../../format.ts';
import type { ServerMode } from '../../server-mode.ts';
import { ACCENT, ERR, OK, Rule, fit } from '../widgets/index.ts';

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

function uptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

/** The console while serving (@web:server): addresses, clients, rate limiting, downloads, activity. */
export function ServerPanel({ mode, status, width, height, onQuit }: { mode: ServerMode; status: Status; width: number; height: number; onQuit: () => void }) {
  const s = mode.stats;
  const tasks = s.tasks();
  const running = tasks.filter((t) => t.status === 'running');
  const speed = running.reduce((a, t) => a + (t.speed ?? 0), 0);
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const rows: [string, string][] = [
    ['地址', mode.urls.join('  ')],
    ['运行', `${uptime(Date.now() - s.started)} · 浏览器 ${s.streams} · 会话 ${s.sessions.size}`],
    ['请求', `${s.requests} 次 · 限流 ${s.limited} 次（每个地址：搜索/打开 1 次每秒，突发 8 次）`],
    ['下载', `${running.length} 个进行中${speed ? ` · ${formatSpeed(speed)}` : ''} · 完成 ${done}${failed ? ` · 失败 ${failed}` : ''}`],
    ['控制台', '只能 @login <网站> 登录，或 @web:server quit 退出；网页端不能登录或修改设置'],
  ];
  const logRows = Math.max(0, height - rows.length - 3);
  const label = 8;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Rule
        title="服务端"
        detail={status.text || `运行中 · 端口 ${mode.port}`}
        tone={status.tone === 'error' ? 'error' : status.tone === 'ok' ? 'ok' : undefined}
        busy={status.tone === 'busy'}
        width={width}
        action={{ label: '退出服务端', onPress: onQuit }}
      />
      {rows.map(([k, v]) => (
        <Box key={k} width={width}>
          <Text color={ACCENT}>{` ${k.padEnd(label - stringPad(k))}`}</Text>
          <Text>{fit(v, width - label - 2)}</Text>
        </Box>
      ))}
      <Rule title="活动" detail={s.log.length ? `最近 ${Math.min(s.log.length, logRows)} 条` : '还没有请求'} width={width} />
      {s.log.slice(0, logRows).map((l, i) => (
        <Box key={`${l.at}-${i}`} width={width}>
          <Text dimColor>{` ${clock(l.at)} `}</Text>
          <Text dimColor>{fit(l.ip.replace(/^::ffff:/, ''), 16).padEnd(16)}</Text>
          <Text color={l.tone === 'error' ? ERR : l.tone === 'ok' ? OK : undefined}>{fit(l.text, Math.max(0, width - 27))}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** CJK labels take two cells each: pad by display width. */
function stringPad(s: string): number {
  return [...s].filter((c) => c.charCodeAt(0) > 0x2e80).length;
}
