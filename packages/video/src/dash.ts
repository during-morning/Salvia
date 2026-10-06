import { rm } from 'node:fs/promises';
import { FatalError, HttpError, type Progress } from '@salvia/core';
import { downloadFile, mux, runFfmpeg, toAudio } from '@salvia/media';
import type { Format, Resolved, Stream } from './model.ts';

export interface DashOptions {
  signal: AbortSignal;
  report: (p: Progress) => void;
  /** Size of each ranged request; YouTube needs < ~10MB to avoid throttling. */
  chunkSize?: number;
}

/**
 * Download a format's streams (in parallel, resumable) and produce `out`:
 * video+audio are muxed without re-encoding, audio-only is remuxed/transcoded to `format.ext`.
 */
export async function downloadFormat(res: Resolved, format: Format, out: string, opts: DashOptions): Promise<string> {
  const parts: { stream: Stream; path: string; done: number; total: number }[] = [];
  if (format.video) parts.push({ stream: format.video, path: `${out}.video.m4s`, done: 0, total: 0 });
  if (format.audio) parts.push({ stream: format.audio, path: `${out}.audio.m4s`, done: 0, total: 0 });
  if (!parts.length) throw new FatalError('没有可下载的流。');
  for (const p of parts) p.total = p.stream.size ?? (p.stream.bandwidth * res.duration) / 8;

  // Downloads take 95% of the bar, ffmpeg the rest.
  const speeds = new Map<string, number>();
  const tick = () => {
    const done = parts.reduce((a, p) => a + p.done, 0);
    const total = parts.reduce((a, p) => a + Math.max(p.total, p.done), 0);
    const speed = [...speeds.values()].reduce((a, b) => a + b, 0);
    opts.report({ progress: total ? (done / total) * 0.95 : -1, speed });
  };

  await Promise.all(
    parts.map((p) =>
      fetchWithBackups(p.stream, p.path, res.headers, opts, (done, total, speed) => {
        p.done = done;
        if (total) p.total = total;
        speeds.set(p.path, speed);
        tick();
      }),
    ),
  );
  speeds.clear();

  const finish = (x: number) => opts.report({ progress: 0.95 + 0.05 * x });
  const ff = { signal: opts.signal, duration: res.duration, onProgress: finish };
  const meta = { title: res.title, artist: res.uploader };
  const [video, audio] = format.video ? parts : [undefined, parts[0]];
  if (video && audio) await mux(video.path, audio.path, out, { ...ff, meta });
  else if (audio) {
    const ext = format.ext === 'mp4' || format.ext === 'webm' ? 'm4a' : format.ext;
    await toAudio(audio.path, out, ext, { ...ff, meta, inputCodec: audio.stream.codec });
  } else await runFfmpeg(['-i', video!.path, '-c', 'copy', out], ff);

  await Promise.all(parts.map((p) => rm(p.path, { force: true })));
  return out;
}

async function fetchWithBackups(
  stream: Stream,
  path: string,
  headers: Record<string, string>,
  opts: DashOptions,
  onProgress: (done: number, total: number | undefined, speed: number) => void,
): Promise<void> {
  const urls = [stream.url, ...stream.backups];
  let last: unknown;
  for (const url of urls) {
    try {
      // The other CDN mirrors carry the same file: pieces are spread over all of them.
      const mirrors = urls.filter((u) => u !== url);
      await downloadFile(url, path, { headers, signal: opts.signal, onProgress, size: stream.size, chunkSize: opts.chunkSize, mirrors });
      return;
    } catch (err) {
      if (opts.signal.aborted) throw err;
      last = err;
    }
  }
  if (last instanceof HttpError && last.status === 403) throw new Error('下载链接已失效或被拒绝（403），稍后重试会重新解析。');
  throw last;
}
