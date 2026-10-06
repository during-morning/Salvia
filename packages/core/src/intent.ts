import { registry } from './registry.ts';
import type { Intent } from './types.ts';

/**
 * What an input means. The syntax (`@music:<platform> 关键词`, `@parse`, links) is fixed here; which
 * hosts, ids and platforms exist comes from the installed modules (registry.ts).
 */

export type SearchType = 'novel' | 'music' | 'video' | 'anime';
export const SEARCH_TYPES: SearchType[] = ['novel', 'music', 'video', 'anime'];

/** Canonical `@music:` / `@video:` platform id for what was typed. */
export function resolvePlatform(type: 'music' | 'video', name: string): string | undefined {
  return registry.resolvePlatform(type, name);
}

/** `@novel 书名` · `@music:qq-music 歌名` · `@video 关键词` (also the common typo `@viedo`) */
const SEARCH = /^@(novel|music|video|viedo|anime)(?::(\S+))?(?:\s+(\S[\s\S]*))?$/i;
/** `@parse 内容` · `@parse:<platform> 内容` */
const PARSE = /^@parse(?::(\S+))?(?:\s+(\S[\s\S]*))?$/i;

/** Pull the first http(s) URL out of text, so share snippets like "【标题】 https://b23.tv/xx" work. */
export function extractUrl(text: string): URL | undefined {
  const m = text.match(/https?:\/\/[^\s"'<>，。】]+/i);
  if (!m) return undefined;
  try {
    return new URL(m[0]);
  } catch {
    return undefined;
  }
}

function fromUrl(url: URL): Intent {
  // First match wins; modules register specific hosts before broad ones (qishui.douyin.com …).
  const rule = registry.hosts.find((r) => r.pattern.test(url.hostname) && (!r.path || r.path.test(url.pathname)));
  return rule ? { kind: rule.kind, input: url.href, site: rule.site } : { kind: 'video', input: url.href };
}

/** Bare ids recognised without a platform hint, in the modules' order of preference. */
function bareRules() {
  return registry.ids.filter((r) => r.bare !== undefined).sort((a, b) => a.bare! - b.bare!);
}

/**
 * Recognise a link or a bare id by its format. A platform hint settles ambiguous ids
 * (e.g. digits are a NetEase song id unless the hint says otherwise).
 */
export function parseTarget(raw: string, platform?: string): Intent | undefined {
  const text = raw.trim();
  const url = extractUrl(text);
  if (url) return fromUrl(url);
  const p = platform?.toLowerCase();
  if (p) {
    // The hint names a platform (any spelling), or a site without one (douyin, bt).
    const ids = new Set([registry.resolvePlatform('music', p), registry.resolvePlatform('video', p), p].filter(Boolean));
    const rule = registry.ids.find((r) => ((r.platform && ids.has(r.platform)) || ids.has(r.site)) && r.pattern.test(text));
    return rule ? { kind: rule.kind, input: rule.link(text), site: rule.site } : undefined;
  }
  const rule = bareRules().find((r) => r.pattern.test(text));
  return rule ? { kind: rule.kind, input: rule.link(text), site: rule.site } : undefined;
}

/** Ids that work typed alone, without @parse (BV号 and the like: unambiguous). */
function standalone(text: string): Intent | undefined {
  const rule = registry.ids.find((r) => r.bare !== undefined && r.bare < 0 && r.pattern.test(text));
  return rule ? { kind: rule.kind, input: rule.link(text), site: rule.site } : undefined;
}

export function detectIntent(raw: string): Intent {
  const text = raw.trim();
  if (!text) return { kind: 'empty', input: '' };

  if (text.startsWith('@')) {
    const search = text.match(SEARCH);
    if (search) {
      const type = (search[1]!.toLowerCase() === 'viedo' ? 'video' : search[1]!.toLowerCase()) as SearchType;
      const platform = search[2];
      const keyword = search[3]?.trim();
      // Without a keyword it is a command, which explains what is missing.
      if (!keyword) return { kind: 'command', input: text.slice(1) };
      if (platform && (type === 'music' || type === 'video')) {
        const id = resolvePlatform(type, platform);
        if (!id) return { kind: 'command', input: `${type}:${platform} ${keyword}` };
        return { kind: `${type}-search`, input: keyword, platform: id };
      }
      return { kind: `${type}-search`, input: keyword, platform };
    }
    const parse = text.match(PARSE);
    if (parse) {
      const target = parse[2] ? parseTarget(parse[2], parse[1]) : undefined;
      return target ?? { kind: 'command', input: text.slice(1) };
    }
    return { kind: 'command', input: text.slice(1).trim() };
  }

  // Links work without @parse too; they are unambiguous.
  const id = standalone(text);
  if (id) return id;
  const url = extractUrl(text);
  if (url) return fromUrl(url);

  return { kind: 'text', input: text };
}
