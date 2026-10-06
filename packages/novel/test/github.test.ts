import { describe, expect, it } from 'vitest';

process.env.GH_TOKEN = 'test-token';
const { githubHeaders, rawGithubUrl } = await import('../src/github.ts');

describe('GitHub book source links', () => {
  it('sends the GitHub login to GitHub over https only', () => {
    expect(githubHeaders('https://raw.githubusercontent.com/me/novel_source/main/sources.json')).toEqual({ authorization: 'Bearer test-token' });
    expect(githubHeaders('https://gist.githubusercontent.com/me/abc/raw/s.json')).toEqual({ authorization: 'Bearer test-token' });
    expect(githubHeaders('http://raw.githubusercontent.com/me/r/main/s.json')).toEqual({});
    expect(githubHeaders('https://raw.githubusercontent.com.evil.example/s.json')).toEqual({});
    expect(githubHeaders('https://example.com/sources.json')).toEqual({});
  });

  it('turns a file page into its raw link', () => {
    expect(rawGithubUrl('https://github.com/me/novel_source/blob/main/sources.json')).toBe('https://raw.githubusercontent.com/me/novel_source/main/sources.json');
    expect(rawGithubUrl('https://example.com/a.json')).toBe('https://example.com/a.json');
  });
});
