import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Book sources kept in a private GitHub repo or gist: their links answer 404 without the user's
 * GitHub login. The token comes from GH_TOKEN / GITHUB_TOKEN or the GitHub CLI (`gh auth token`),
 * and is only ever sent to GitHub over https.
 */

const GITHUB_HOSTS = /^(github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com|api\.github\.com)$/i;

export function isGithub(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GITHUB_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** A file page (github.com/<owner>/<repo>/blob/<ref>/<path>) as its raw link. */
export function rawGithubUrl(url: string): string {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

let cached: string | null | undefined;

export function githubToken(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return (cached = env);
  // `gh` on PATH, or where its installers put it (PATH may predate the install).
  const candidates = [
    'gh',
    ...(process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
      : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']),
  ];
  for (const gh of candidates) {
    try {
      const token = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (token) return (cached = token);
    } catch {
      // not installed / not logged in
    }
  }
  cached = null;
  return undefined;
}

/** Headers for fetching `url`: the GitHub login for GitHub links, nothing otherwise. */
export function githubHeaders(url: string): Record<string, string> {
  const token = isGithub(url) ? githubToken() : undefined;
  return token ? { authorization: `Bearer ${token}` } : {};
}
