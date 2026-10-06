import type { SalviaModule } from '@salvia/core';
import { animeHandler } from './handler.ts';

export { bangumiSearch, bangumiSubject, infoValue, type Subject } from './bangumi.ts';
export { ANIME_SOURCES, animeSource, animeSources, matchCatalog, type AnimeOffers, type AnimeSource, type AnimeTitle, type CatalogEntry } from './sources.ts';
export { animeHandler } from './handler.ts';

/**
 * The anime feature: `@anime` lists titles from Bangumi, and each title's downloads come from the
 * registered `ANIME_SOURCES` (official catalogues first, then indexes).
 */
export const animeModule: SalviaModule = {
  id: 'anime',
  setup(api) {
    api.handler(animeHandler);
    api.site({ id: 'bangumi', name: 'Bangumi', hosts: /(^|\.)(bgm\.tv|bangumi\.tv|chii\.in)$/ });
  },
};
