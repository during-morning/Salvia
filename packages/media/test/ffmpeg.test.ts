import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegPath, mux, runFfmpeg, toAudio } from '../src/ffmpeg.ts';

const dir = mkdtempSync(join(tmpdir(), 'salvia-ff-'));

describe('ffmpeg', () => {
  it('uses the bundled binary, not PATH', () => {
    expect(ffmpegPath()).toMatch(/ffmpeg-static[\\/]ffmpeg(\.exe)?$/);
  });

  it('muxes video + audio and converts audio, reporting progress', async () => {
    const v = join(dir, 'v.mp4');
    const a = join(dir, 'a.m4a');
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'aac', a]);

    const out = join(dir, 'out.mp4');
    let progress = 0;
    await mux(v, a, out, { duration: 2, onProgress: (p) => (progress = p), meta: { title: '测试' } });
    expect(statSync(out).size).toBeGreaterThan(1000);
    expect(progress).toBeGreaterThan(0.5);

    const mp3 = join(dir, 'out.mp3');
    await toAudio(a, mp3, 'mp3', { inputCodec: 'mp4a.40.2', meta: { title: '歌', artist: '人' } });
    expect(existsSync(mp3)).toBe(true);

    const m4a = join(dir, 'copy.m4a');
    await toAudio(a, m4a, 'm4a', { inputCodec: 'mp4a.40.2' });
    expect(existsSync(m4a)).toBe(true);
  }, 30_000);

  it('aborts', async () => {
    const ac = new AbortController();
    const p = runFfmpeg(['-f', 'lavfi', '-i', 'sine', '-t', '600', '-f', 'null', '-'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBeTruthy();
  });
});
