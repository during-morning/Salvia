import { Session, coreModule, demoHandler, install, probeAll, registry, warmUp, type SalviaModule } from '@salvia/core';
import { animeModule } from '@salvia/anime';
import { mediaModule, playClip } from '@salvia/media';
import { musicModule } from '@salvia/music';
import { novelModule } from '@salvia/novel';
import { platformModules } from '@salvia/platforms';
import { videoModule } from '@salvia/video';

/**
 * The composition root: which modules make up Salvia. Core and media, then the platforms (their
 * order decides overlapping host rules), then the features that use what the platforms provide.
 */
export const modules: SalviaModule[] = [coreModule, mediaModule, ...platformModules, videoModule, musicModule, animeModule, novelModule];

/** Install every module once (idempotent; all sessions share the registry). */
export function installAll(): void {
  install(...modules);
}

/** A session with every module available. Shared by the server, the TUI and script mode. */
export function createSession(): Session {
  installAll();
  const session = new Session();
  session.setPlayer(playClip);
  if (process.env.SALVIA_DEMO === '1') session.register(demoHandler);
  return session;
}

/**
 * For the TUI and the web UI: check which sites answer from this network, and open connections
 * and fetch tokens while the user is still typing, so the first search is fast.
 */
export function prewarm(): void {
  installAll();
  void probeAll();
  warmUp([...registry.sites.values()].flatMap((s) => s.prewarm ?? []));
  for (const warm of registry.warmers) warm();
}
