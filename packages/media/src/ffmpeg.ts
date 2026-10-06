import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FatalError, isPackaged, loadConfig, packagedAsset, salviaHome } from '@salvia/core';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/**
 * The single-file build carries ffmpeg gzip-compressed (asset "ffmpeg.gz", hash in "ffmpeg.sha256").
 * Unpack it once into ~/.salvia/bin/<hash>/ and verify it.
 */
function extractEmbedded(): string | undefined {
  const hash = packagedAsset('ffmpeg.sha256')?.toString().trim();
  if (!hash) return undefined;
  const dir = join(salviaHome(), 'bin', hash.slice(0, 16));
  const target = join(dir, EXE);
  const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
  if (existsSync(target) && sha(readFileSync(target)) === hash) return target;
  const packed = packagedAsset('ffmpeg.gz');
  if (!packed) return undefined;
  const bin = gunzipSync(packed);
  if (sha(bin) !== hash) throw new FatalError('内置的 ffmpeg 校验失败，请重新下载 Salvia。');
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, bin);
  if (process.platform !== 'win32') chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  return target;
}

let resolved: string | undefined;

/**
 * Locate ffmpeg. Never looks at PATH: Salvia always uses the binary it ships with, so behaviour is
 * the same on every machine. Order: `@ffmpeg <path>` config, SALVIA_FFMPEG, the copy embedded in
 * the single-file build, then the ffmpeg-static package (source checkout / npm install).
 */
export function ffmpegPath(): string {
  const configured = loadConfig().extra.ffmpeg;
  if (typeof configured === 'string' && existsSync(configured)) return configured;
  const env = process.env.SALVIA_FFMPEG;
  if (env && existsSync(env)) return env;
  if (resolved && existsSync(resolved)) return resolved;
  if (isPackaged()) {
    resolved = extractEmbedded();
    if (resolved) return resolved;
  } else {
    try {
      const bundled = createRequire(import.meta.url)('ffmpeg-static') as string | null;
      if (bundled && existsSync(bundled)) return (resolved = bundled);
    } catch {
      // not installed
    }
  }
  throw new FatalError('找不到随包的 ffmpeg，请重新安装 Salvia。');
}

export interface FfmpegOptions {
  signal?: AbortSignal;
  /** Total duration in seconds, to turn ffmpeg's out_time into a 0..1 progress. */
  duration?: number;
  onProgress?: (p: number) => void;
}

/** Run ffmpeg with `args` (input/output included). Rejects with the tail of stderr on failure. */
export function runFfmpeg(args: string[], opts: FfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let err = '';
    proc.stderr.on('data', (b: Buffer) => {
      err = (err + b.toString()).slice(-4000);
    });
    let buf = '';
    proc.stdout.on('data', (b: Buffer) => {
      buf += b.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && opts.duration) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(opts.signal.reason);
      if (code === 0) return resolve();
      const last = err.trim().split('\n').slice(-3).join(' ');
      reject(new Error(`ffmpeg 失败（${code}）：${last}`));
    });
  });
}

export interface Metadata {
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  comment?: string;
  lyrics?: string;
  [key: string]: string | undefined;
}

function metaArgs(meta: Metadata = {}): string[] {
  return Object.entries(meta).flatMap(([k, v]) => (v ? ['-metadata', `${k}=${v}`] : []));
}

/** Combine separate video and audio streams without re-encoding. */
export async function mux(
  video: string,
  audio: string,
  out: string,
  opts: FfmpegOptions & { meta?: Metadata } = {},
): Promise<void> {
  const tmp = tmpName(out);
  const ext = extname(out).toLowerCase();
  const faststart = ext === '.mp4' || ext === '.m4a' ? ['-movflags', '+faststart'] : [];
  await runFfmpeg(
    ['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...faststart, ...metaArgs(opts.meta), tmp],
    opts,
  );
  await rename(tmp, out);
}

export type AudioFormat = 'm4a' | 'mp3' | 'flac' | 'opus' | 'ogg';

/**
 * Turn `input` into an audio file in `format`, copying the stream when the codec already fits and
 * transcoding otherwise. Optionally embeds a cover image and tags.
 */
export async function toAudio(
  input: string,
  out: string,
  format: AudioFormat,
  opts: FfmpegOptions & { meta?: Metadata; cover?: string; inputCodec?: string; bitrate?: string } = {},
): Promise<void> {
  const tmp = tmpName(out);
  const codec = opts.inputCodec ?? '';
  const copy =
    (format === 'm4a' && /^mp4a|aac/i.test(codec)) ||
    (format === 'mp3' && /mp3/i.test(codec)) ||
    (format === 'flac' && /flac/i.test(codec)) ||
    ((format === 'opus' || format === 'ogg') && /opus|vorbis/i.test(codec));
  const encoder: Record<AudioFormat, string[]> = {
    m4a: ['-c:a', 'aac', '-b:a', opts.bitrate ?? '192k'],
    mp3: ['-c:a', 'libmp3lame', '-b:a', opts.bitrate ?? '320k'],
    flac: ['-c:a', 'flac'],
    opus: ['-c:a', 'libopus', '-b:a', opts.bitrate ?? '160k'],
    ogg: ['-c:a', 'libvorbis', '-q:a', '6'],
  };
  const coverOk = opts.cover && format !== 'opus' && format !== 'ogg';
  const args = ['-i', input];
  if (coverOk) args.push('-i', opts.cover!);
  args.push('-map', '0:a:0');
  if (coverOk) args.push('-map', '1:0', '-c:v', format === 'flac' ? 'copy' : 'mjpeg', '-disposition:v:0', 'attached_pic');
  args.push(...(copy ? ['-c:a', 'copy'] : encoder[format]));
  if (format === 'mp3') args.push('-id3v2_version', '3');
  if (format === 'm4a') args.push('-movflags', '+faststart');
  args.push(...metaArgs(opts.meta), '-f', format === 'm4a' ? 'ipod' : format === 'opus' ? 'opus' : format, tmp);
  await runFfmpeg(args, opts);
  await rename(tmp, out);
}

function tmpName(out: string): string {
  const ext = extname(out);
  return `${out.slice(0, out.length - ext.length)}.tmp${ext}`;
}
