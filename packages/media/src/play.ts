import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { FatalError, type AudioClip } from '@salvia/core';
import { ffmpegPath, runFfmpeg } from './ffmpeg.ts';

/**
 * 试听: ffmpeg cuts the clip to a WAV file (any source it can read, with the site's headers), then
 * the system's own player plays it. No extra binaries: PowerShell's SoundPlayer on Windows,
 * afplay on macOS, paplay/aplay on Linux.
 */

function inputArgs(clip: AudioClip): string[] {
  const headers = Object.entries(clip.headers ?? {})
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  return [
    ...(headers ? ['-headers', headers] : []),
    ...(clip.start ? ['-ss', String(clip.start)] : []),
    '-t',
    String(clip.duration ?? 30),
    '-i',
    clip.url,
    '-vn',
  ];
}

function playerCommand(file: string): [string, string[]] | undefined {
  if (process.platform === 'win32') {
    const path = file.replace(/'/g, "''");
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`]];
  }
  if (process.platform === 'darwin') return ['afplay', [file]];
  for (const [bin, args] of [
    ['paplay', [file]],
    ['aplay', ['-q', file]],
  ] as const) {
    if ((process.env.PATH ?? '').split(':').some((d) => existsSync(join(d, bin)))) return [bin, [...args]];
  }
  return undefined;
}

let seq = 0;

export async function playClip(clip: AudioClip, opts: { signal: AbortSignal; onStart: () => void }): Promise<void> {
  const file = join(tmpdir(), `salvia-preview-${process.pid}-${seq++}.wav`);
  try {
    await runFfmpeg([...inputArgs(clip), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', file], { signal: opts.signal });
    const cmd = playerCommand(file);
    if (!cmd) throw new FatalError('没有找到可用的系统播放器（需要 paplay 或 aplay）。');
    await new Promise<void>((resolve, reject) => {
      const proc: ChildProcess = spawn(cmd[0], cmd[1], { stdio: 'ignore', windowsHide: true });
      const stop = () => proc.kill();
      opts.signal.addEventListener('abort', stop, { once: true });
      proc.on('spawn', opts.onStart);
      proc.on('error', reject);
      proc.on('close', () => {
        opts.signal.removeEventListener('abort', stop);
        resolve();
      });
    });
  } finally {
    rmSync(file, { force: true });
  }
}

/** The clip as an MP3 stream, for the web UI's <audio> (the browser can't send the site's headers). */
export function clipStream(clip: AudioClip, signal?: AbortSignal): Readable {
  const proc = spawn(
    ffmpegPath(),
    ['-hide_banner', '-nostdin', '-loglevel', 'error', ...inputArgs(clip), '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  signal?.addEventListener('abort', () => proc.kill(), { once: true });
  return proc.stdout;
}
