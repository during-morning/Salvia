import type { Format, Stream } from '@salvia/video';

export interface RawFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  bitrate: number;
  averageBitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  contentLength?: string;
  qualityLabel?: string;
  audioQuality?: string;
  isDrc?: boolean;
  audioTrack?: { displayName: string; audioIsDefault: boolean };
}

interface Parsed {
  raw: RawFormat;
  container: string;
  codec: string;
  stream: Stream;
}

function parse(f: RawFormat): Parsed | undefined {
  if (!f.url) return undefined; // ciphered formats need a JS player; not used by our clients
  const m = f.mimeType.match(/^(\w+)\/(\w+);\s*codecs="([^"]+)"/);
  if (!m) return undefined;
  const codec = m[3]!;
  return {
    raw: f,
    container: m[2]!,
    codec,
    stream: {
      url: f.url,
      backups: [],
      codec,
      bandwidth: f.averageBitrate ?? f.bitrate,
      size: f.contentLength ? Number(f.contentLength) : undefined,
    },
  };
}

const VIDEO_RANK = (p: Parsed) => (p.codec.startsWith('avc1') ? 0 : p.codec.startsWith('av01') ? 1 : 2);

function codecName(codec: string): string {
  if (codec.startsWith('avc1')) return 'H.264';
  if (codec.startsWith('av01')) return 'AV1';
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9';
  return codec;
}

/**
 * One format per resolution: mp4 (H.264, else AV1) paired with m4a audio so the result is a plain
 * .mp4; VP9-only resolutions pair with Opus into .webm. Audio-only m4a last.
 */
export function buildFormats(adaptive: RawFormat[]): Format[] {
  const parsed = adaptive.map(parse).filter((p): p is Parsed => !!p);
  // Skip dubbed / DRC duplicates: keep the default audio track.
  const audio = parsed.filter(
    (p) => p.raw.mimeType.startsWith('audio/') && !p.raw.isDrc && (p.raw.audioTrack?.audioIsDefault ?? true),
  );
  const bestOf = (list: Parsed[]) => list.sort((a, b) => b.stream.bandwidth - a.stream.bandwidth)[0];
  const m4a = bestOf(audio.filter((a) => a.container === 'mp4'));
  const opus = bestOf(audio.filter((a) => a.container === 'webm'));

  const byHeight = new Map<string, Parsed>();
  for (const v of parsed.filter((p) => p.raw.mimeType.startsWith('video/'))) {
    const key = `${v.raw.height}p${(v.raw.fps ?? 30) > 30 ? v.raw.fps : ''}`;
    const cur = byHeight.get(key);
    if (!cur || VIDEO_RANK(v) < VIDEO_RANK(cur)) byHeight.set(key, v);
  }

  const formats: Format[] = [...byHeight.entries()]
    .sort(([, a], [, b]) => (b.raw.height ?? 0) - (a.raw.height ?? 0) || (b.raw.fps ?? 0) - (a.raw.fps ?? 0))
    .flatMap(([key, v]) => {
      const webm = v.container === 'webm';
      const a = webm ? opus : m4a;
      if (!a) return [];
      return [
        {
          id: `${key}-${codecName(v.codec)}`,
          label: `${key} · ${codecName(v.codec)}`,
          video: v.stream,
          audio: a.stream,
          ext: webm ? ('webm' as const) : ('mp4' as const),
          height: v.raw.height,
        },
      ];
    });

  if (m4a) formats.push({ id: 'audio', label: '仅音频 · m4a', audio: m4a.stream, ext: 'm4a' });
  if (m4a) formats.push({ id: 'audio-mp3', label: '仅音频 · mp3', audio: m4a.stream, ext: 'mp3' });
  return formats;
}
