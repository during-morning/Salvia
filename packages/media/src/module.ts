import { saveConfig, type SalviaModule } from '@salvia/core';
import { ffmpegPath } from './ffmpeg.ts';

function currentFfmpeg(): string {
  try {
    return ffmpegPath();
  } catch {
    return '未找到';
  }
}

/** `@ffmpeg [路径]`: which ffmpeg converts and muxes (the bundled one by default). */
export const mediaModule: SalviaModule = {
  id: 'media',
  setup(api) {
    api.command({
      name: 'ffmpeg',
      usage: '@ffmpeg [路径]（默认使用随包的 ffmpeg）',
      complete: (args) => (args.length === 1 ? [{ value: '', meta: `可选：ffmpeg.exe 的路径；留空恢复随包的。当前：${currentFfmpeg()}` }] : []),
      run([path], ctx) {
        const extra = { ...ctx.config.extra };
        if (path) extra.ffmpeg = path;
        else delete extra.ffmpeg;
        saveConfig({ extra });
        ctx.status(`ffmpeg：${ffmpegPath()}`, 'ok');
      },
    });
  },
};
