import type { SalviaModule } from '@salvia/core';
import { openVideoLink } from './download.ts';
import { videoSearchHandler } from './search.ts';
import { videoSource } from './sources.ts';

export type { Entry, Format, Listing, Resolved, Stream } from './model.ts';
export { estimateSize, formatDuration } from './model.ts';
export { downloadFormat } from './dash.ts';
export { enqueueVideo, openVideoLink, type Choice } from './download.ts';
export { VIDEO_SOURCES, count, infoPreview, videoSource, videoSources, type VideoHit, type VideoInfo, type VideoSource } from './sources.ts';

/**
 * The video feature: links of any registered video source open as entries → formats → downloads,
 * and `@video` searches every source that can search. Sites come from the `VIDEO_SOURCES` slot.
 */
export const videoModule: SalviaModule = {
  id: 'video',
  setup(api) {
    api.handler({
      id: 'video',
      kinds: ['video'],
      match: (intent) => !!intent.site && !!videoSource(intent.site),
      handle: (ctx) => openVideoLink(ctx, ctx.intent.site!, ctx.intent.input),
    });
    api.handler(videoSearchHandler);
  },
};
