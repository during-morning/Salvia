/**
 * InnerTube client definitions, kept in one place so they can track yt-dlp
 * (yt_dlp/extractor/youtube/_base.py INNERTUBE_CLIENTS) when YouTube changes things.
 *
 * As of yt-dlp 2026.07–08, without login or PO tokens only VISIONOS returns plain, unciphered
 * HTTPS adaptive formats ("_DEFAULT_JSLESS_CLIENTS = ('visionos',)"). The web clients are used
 * only for metadata endpoints (search, browse) which do not need tokens.
 */
export interface ClientConfig {
  name: string;
  /** X-YouTube-Client-Name */
  id: number;
  version: string;
  userAgent: string;
  extra?: Record<string, string | number>;
  host?: string;
}

export const VISIONOS: ClientConfig = {
  name: 'VISIONOS',
  id: 101,
  version: '1.02',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  extra: { deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471' },
};

export const WEB: ClientConfig = {
  name: 'WEB',
  id: 1,
  version: '2.20260708.00.00',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

/** Clients tried in order for /player. */
export const PLAYER_CLIENTS: ClientConfig[] = [VISIONOS];
