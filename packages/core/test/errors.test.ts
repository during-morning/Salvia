import { describe, expect, it } from 'vitest';
import { explainError } from '../src/errors.ts';
import { HttpError } from '../src/http.ts';

describe('explainError', () => {
  it('translates HTTP and network failures', () => {
    expect(explainError(new HttpError(403, 'https://x'))).toContain('403');
    expect(explainError(new HttpError(418, 'https://x'))).toBe('网站返回错误 418。');
    const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
    expect(explainError(dns)).toContain('域名解析失败');
    expect(explainError(new TypeError('fetch failed'))).toContain('网络连接失败');
    expect(explainError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toContain('超时');
    expect(explainError(Object.assign(new Error('x'), { code: 'EACCES' }))).toContain('@dir');
  });

  it('keeps messages already written for people', () => {
    expect(explainError(new Error('视频不存在或已被删除。'))).toBe('视频不存在或已被删除。');
    expect(explainError(new HttpError(500, 'u', '分段下载失败 HTTP 500'))).toBe('网站出错了（500）。');
  });
});
