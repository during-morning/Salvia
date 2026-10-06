import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import type { Session } from '@salvia/core';
import { createSession } from '@salvia/app';
import { ServerStats, startServer } from '@salvia/server';

/**
 * `@web:server <端口>`: Salvia as a server for other devices. Every browser gets its own session,
 * requests are rate limited, logins and settings stay with the console, and the console itself
 * only takes `@login <网站>` and `@web:server quit` while serving.
 */
export interface ServerMode {
  port: number;
  /** Addresses other devices can open. */
  urls: string[];
  stats: ServerStats;
  stop(): Promise<void>;
}

export const serverEvents = new EventEmitter<{ change: [] }>();
let current: ServerMode | undefined;

export const serverMode = (): ServerMode | undefined => current;

export const QUIT = /^@web(?::server|\s+server)\s+(quit|exit|stop)\s*$/i;
const START = /^@web(?::server|\s+server)\b/i;

/** What the console accepts while serving. */
export function consoleFilter(text: string): string | undefined {
  if (!text || QUIT.test(text) || START.test(text) || /^@login\b/i.test(text)) return undefined;
  return '服务端模式运行中：这里只能 @login <网站> 登录，或 @web:server quit 退出服务端模式。';
}

function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return [...out, `http://127.0.0.1:${port}`];
}

export async function startServerMode(console: Session, port: number): Promise<ServerMode> {
  if (current) return current;
  const stats = new ServerStats();
  const { app } = await startServer(console, { port, host: '0.0.0.0', serve: { createSession, stats } });
  const onChange = () => serverEvents.emit('change');
  stats.on('change', onChange);
  console.setInputFilter(consoleFilter);
  current = {
    port,
    urls: lanUrls(port),
    stats,
    async stop() {
      stats.off('change', onChange);
      console.setInputFilter(undefined);
      current = undefined;
      await app.close();
      serverEvents.emit('change');
    },
  };
  serverEvents.emit('change');
  return current;
}
