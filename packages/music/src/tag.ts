import { rename, rm, writeFile } from 'node:fs/promises';
import NodeID3 from 'node-id3';
import { request } from '@salvia/core';
import { toAudio, type AudioFormat } from '@salvia/media';
import type { Lyrics } from './model.ts';

export interface TagInfo {
  title: string;
  artists: string[];
  album?: string;
  cover?: string;
  lyrics?: Lyrics;
}

async function fetchCover(url: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    const res = await request(url, { signal, retries: 1, timeout: 15_000 });
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return undefined; // a missing cover never fails a download
  }
}

/** Plain text of an LRC (for the embedded unsynchronised lyrics frame). */
function lrcText(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\[[^\]]*\])+/, '').trim())
    .filter((l) => l && !/^(作词|作曲|编曲|制作人)\s*[:：]/.test(l))
    .join('\n');
}

export const CODEC: Record<AudioFormat, string> = { mp3: 'mp3', flac: 'flac', m4a: 'mp4a', ogg: 'vorbis', opus: 'opus' };

/**
 * Turn the downloaded `input` into `out` with tags, cover and lyrics embedded, and write a `.lrc`
 * next to it. `input` is removed afterwards.
 */
export async function finalize(
  input: string,
  out: string,
  ext: AudioFormat,
  info: TagInfo,
  opts: { signal?: AbortSignal; inputCodec?: string } = {},
): Promise<string> {
  const cover = info.cover ? await fetchCover(info.cover, opts.signal) : undefined;
  const lyrics = info.lyrics?.lrc;
  const artist = info.artists.join('/');

  if (ext === 'mp3' && (!opts.inputCodec || /mp3/i.test(opts.inputCodec))) {
    await rename(input, out);
    const ok = NodeID3.write(
      {
        title: info.title,
        artist,
        album: info.album,
        image: cover ? { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: cover } : undefined,
        unsynchronisedLyrics: lyrics ? { language: 'zho', text: lrcText(lyrics) } : undefined,
      },
      out,
    );
    if (ok !== true) throw new Error(`写入 ID3 标签失败：${String(ok)}`);
  } else {
    const coverPath = cover ? `${out}.cover.jpg` : undefined;
    if (coverPath) await writeFile(coverPath, cover!);
    try {
      await toAudio(input, out, ext, {
        signal: opts.signal,
        inputCodec: opts.inputCodec ?? CODEC[ext],
        cover: coverPath,
        meta: { title: info.title, artist, album: info.album, lyrics: lyrics ? lrcText(lyrics) : undefined },
      });
    } finally {
      if (coverPath) await rm(coverPath, { force: true });
    }
    await rm(input, { force: true });
  }

  if (lyrics) await writeFile(out.replace(/\.[^.]+$/, '.lrc'), mergeTranslation(info.lyrics!));
  return out;
}

/** LRC with each translated line placed right after its original (same timestamp), as most players expect. */
export function mergeTranslation(l: Lyrics): string {
  if (!l.translation) return l.lrc;
  const tr = new Map<string, string>();
  for (const line of l.translation.split(/\r?\n/)) {
    const m = line.match(/^(\[\d+:\d+(?:[.:]\d+)?\])(.*)$/);
    if (m && m[2]!.trim()) tr.set(m[1]!, m[2]!.trim());
  }
  return l.lrc
    .split(/\r?\n/)
    .flatMap((line) => {
      const stamp = line.match(/^(\[\d+:\d+(?:[.:]\d+)?\])/)?.[1];
      const t = stamp ? tr.get(stamp) : undefined;
      return t ? [line, `${stamp}${t}`] : [line];
    })
    .join('\n');
}
