import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The module rules, checked on every import in packages/*\/src:
 *   core ← media ← features (video, music, anime, novel) ← platforms ← app ← server / cli
 * Features never import platforms or each other, platform folders never import each other, and
 * core never names a site.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packages = join(root, 'packages');

const FEATURES = ['video', 'music', 'anime', 'novel'];
const ALLOWED: Record<string, string[]> = {
  core: [],
  media: ['core'],
  video: ['core', 'media'],
  music: ['core', 'media'],
  anime: ['core'],
  novel: ['core'],
  platforms: ['core', 'media', ...FEATURES],
  server: ['core', 'media'],
  app: ['core', 'media', ...FEATURES, 'platforms', 'server'],
  cli: ['core', 'media', 'app', 'server', 'novel'],
  web: [],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function imports(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  return [...code.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]!);
}

const sources = Object.keys(ALLOWED).flatMap((pkg) => {
  const src = join(packages, pkg, 'src');
  try {
    return files(src).map((file) => ({ pkg, file, rel: relative(packages, file).replace(/\\/g, '/') }));
  } catch {
    return [];
  }
});

describe('architecture', () => {
  it('sees the whole source tree', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.filter((s) => s.pkg === 'platforms').length).toBeGreaterThan(30);
    expect(sources.some((s) => imports(s.file).includes('@salvia/music'))).toBe(true);
  });

  it('packages only import the layers below them', () => {
    const bad: string[] = [];
    for (const { pkg, file, rel } of sources) {
      for (const spec of imports(file)) {
        const dep = spec.match(/^@salvia\/([\w-]+)/)?.[1];
        if (dep && dep !== pkg && !ALLOWED[pkg]!.includes(dep)) bad.push(`${rel} → @salvia/${dep}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('platform folders are independent of each other', () => {
    const bad: string[] = [];
    for (const { pkg, file, rel } of sources) {
      if (pkg !== 'platforms') continue;
      const own = rel.split('/')[2]!; // platforms/src/<platform>/…
      if (!own.includes('.')) {
        for (const spec of imports(file)) {
          if (!spec.startsWith('.')) continue;
          const target = relative(join(packages, 'platforms', 'src'), resolve(dirname(file), spec)).replace(/\\/g, '/');
          if (target.split('/')[0] !== own) bad.push(`${rel} → ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('core names no site: platforms come from modules', () => {
    const SITES = /\b(bilibili|youtube|netease|spotify|douyin|kugou|kuwo|migu|qqmusic|jamendo|joox|qishui|mikan|dmhy|bangumi)\b/i;
    const bad = sources
      .filter((s) => s.pkg === 'core')
      .flatMap(({ file, rel }) =>
        stripComments(readFileSync(file, 'utf8'))
          .split('\n')
          .filter((line) => SITES.test(line))
          .map((line) => `${rel}: ${line.trim()}`),
      );
    expect(bad).toEqual([]);
  });
});
