import { getText } from '@salvia/core';

/**
 * Anime BitTorrent indexes (the ones Animeko ships: 动漫花园, Mikan; plus ACG.RIP), searched
 * through their public RSS feeds. Salvia only lists what they index; what is downloaded from the
 * swarm is the user's choice.
 */

export interface BtResource {
  title: string;
  /** Which index listed it. */
  source: '动漫花园' | 'Mikan' | 'ACG.RIP';
  /** The index's page for it. */
  page?: string;
  /** magnet: or .torrent URL */
  magnet?: string;
  torrent?: string;
  /** Lower-case hex info hash, when known (for de-duplication). */
  hash?: string;
  size?: number;
  date?: number;
  group?: string;
  /** "05", "01-28" … */
  episode?: string;
  resolution?: string;
  subtitle?: string;
}

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' };

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function tag(item: string, name: string): string | undefined {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]!) : undefined;
}

function attr(item: string, name: string, key: string): string | undefined {
  const m = item.match(new RegExp(`<${name}\\s[^>]*${key}="([^"]*)"`));
  return m ? unescapeXml(m[1]!) : undefined;
}

const items = (xml: string) => xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

/** btih from a magnet link as lower-case hex (base32 hashes converted). */
export function infoHash(magnet: string): string | undefined {
  const h = magnet.match(/btih:([0-9a-zA-Z]+)/)?.[1];
  if (!h) return undefined;
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (h.length !== 32) return undefined;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of h.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return bits.match(/.{8}/g)!.map((b) => parseInt(b, 2).toString(16).padStart(2, '0')).join('');
}

const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** "[48.5GB]" / "1.2 GiB" → bytes */
export function parseSize(text: string): number | undefined {
  const m = text.match(/([\d.]+)\s*([KMGT]?)i?B\b/i);
  return m ? Math.round(Number(m[1]) * UNITS[`${m[2]!.toUpperCase()}B`]!) : undefined;
}

/** Group, episode, resolution and subtitle language from a release title. */
export function parseRelease(title: string): Pick<BtResource, 'group' | 'episode' | 'resolution' | 'subtitle'> {
  const group = title.match(/^\s*[[【]([^\]】]+)[\]】]/)?.[1]?.trim();
  const range = title.match(/(?:^|[\s[【第|])(\d{1,4})\s*[-~～]\s*(\d{1,4})(?=[\s\]】话話集+|]|$)/);
  const single =
    title.match(/第\s*(\d{1,4}(?:\.\d)?)\s*[话話集]/) ??
    title.match(/[[【]\s*(\d{1,4}(?:\.\d)?)(?:v\d)?\s*(?:END|FIN)?[\]】]/i) ??
    title.match(/\s-\s(\d{1,4}(?:\.\d)?)(?:v\d)?(?=[\s[【(]|$)/);
  const episode = range ? `${range[1]}-${range[2]}` : single?.[1] ?? (/合集|全集|BDrip|BDRip|Fin\b|S\d{2}\s*\+/i.test(title) ? '合集' : undefined);
  const res = title.match(/\b(2160|1080|720|480)[pP]\b|\b(4K)\b/);
  const resolution = res ? (res[2] ? '2160p' : `${res[1]}p`) : undefined;
  const sub = [
    /简繁|繁简|CHS[_&\s]*CHT|GB[_&\s]*BIG5/i.test(title) ? '简繁' : /简|CHS|GB(?!\w)|SC\b/i.test(title) ? '简' : /繁|CHT|BIG5|TC\b/i.test(title) ? '繁' : '',
    /内封|內封/.test(title) ? '内封' : /内嵌|內嵌/.test(title) ? '内嵌' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { group, episode, resolution, subtitle: sub || undefined };
}

async function feed(url: string, signal?: AbortSignal): Promise<string> {
  // One unreachable index must not hold up the others' results.
  return getText(url, { headers: UA, signal, timeout: 8_000, retries: 0 });
}

export async function searchDmhy(keyword: string, signal?: AbortSignal): Promise<BtResource[]> {
  const xml = await feed(`https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(keyword)}`, signal);
  return items(xml).map((it) => {
    const title = tag(it, 'title') ?? '';
    const magnet = attr(it, 'enclosure', 'url');
    return {
      title,
      source: '动漫花园' as const,
      page: tag(it, 'link'),
      magnet: magnet?.startsWith('magnet:') ? magnet : undefined,
      hash: magnet ? infoHash(magnet) : undefined,
      date: Date.parse(tag(it, 'pubDate') ?? '') || undefined,
      ...parseRelease(title),
    };
  });
}

export async function searchMikan(keyword: string, signal?: AbortSignal): Promise<BtResource[]> {
  const xml = await feed(`https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent(keyword)}`, signal);
  return items(xml).map((it) => {
    const title = tag(it, 'title') ?? '';
    const page = tag(it, 'link');
    const hash = page?.match(/Episode\/([0-9a-f]{40})/i)?.[1]?.toLowerCase();
    return {
      title,
      source: 'Mikan' as const,
      page,
      torrent: attr(it, 'enclosure', 'url'),
      magnet: hash ? `magnet:?xt=urn:btih:${hash}` : undefined,
      hash,
      size: Number(tag(it, 'contentLength')) || parseSize(tag(it, 'description') ?? '') || undefined,
      date: Date.parse(tag(it, 'pubDate') ?? '') || undefined,
      ...parseRelease(title),
    };
  });
}

export async function searchAcgRip(keyword: string, signal?: AbortSignal): Promise<BtResource[]> {
  const xml = await feed(`https://acg.rip/.xml?term=${encodeURIComponent(keyword)}`, signal);
  return items(xml).map((it) => {
    const title = tag(it, 'title') ?? '';
    return {
      title,
      source: 'ACG.RIP' as const,
      page: tag(it, 'link'),
      torrent: attr(it, 'enclosure', 'url'),
      size: Number(tag(it, 'torrent:contentLength')) || undefined,
      date: Date.parse(tag(it, 'pubDate') ?? '') || undefined,
      ...parseRelease(title),
    };
  });
}

const normTitle = (t: string) => t.toLowerCase().replace(/[\s[\]【】()（）_\-.]/g, '');

/** All three indexes, newest first, the same release listed once (by info hash, else title). */
export async function searchBt(keyword: string, signal?: AbortSignal): Promise<{ resources: BtResource[]; failed: string[] }> {
  const sources = [
    ['动漫花园', searchDmhy],
    ['Mikan', searchMikan],
    ['ACG.RIP', searchAcgRip],
  ] as const;
  const failed: string[] = [];
  const lists = await Promise.all(
    sources.map(([name, fn]) =>
      fn(keyword, signal).catch(() => {
        failed.push(name);
        return [] as BtResource[];
      }),
    ),
  );
  const seen = new Map<string, BtResource>();
  const byTitle = new Map<string, BtResource>();
  for (const r of lists.flat()) {
    const title = normTitle(r.title);
    const key = r.hash ?? title;
    const prev = seen.get(key) ?? byTitle.get(title);
    if (!prev) {
      seen.set(key, r);
      byTitle.set(title, r);
    } else {
      // Keep one entry, with whatever each index knew.
      prev.torrent ??= r.torrent;
      prev.magnet ??= r.magnet;
      prev.hash ??= r.hash;
      prev.size ??= r.size;
    }
  }
  const resources = [...seen.values()].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return { resources, failed };
}
