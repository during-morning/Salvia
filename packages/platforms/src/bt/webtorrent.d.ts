// The parts of WebTorrent's API Salvia uses (the package ships no types).
declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events';

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    downloaded: number;
    progress: number;
    select(): void;
    deselect(): void;
  }

  export interface Torrent extends EventEmitter {
    infoHash: string;
    name: string;
    files: TorrentFile[];
    ready: boolean;
    downloadSpeed: number;
    numPeers: number;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: Record<string, unknown>);
    torrents: Torrent[];
    add(id: string | Uint8Array, opts?: Record<string, unknown>, ontorrent?: (t: Torrent) => void): Torrent;
    get(id: string): Promise<Torrent | null> | Torrent | null;
    destroy(cb?: (err?: Error) => void): void;
  }
}
