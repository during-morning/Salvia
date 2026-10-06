import { HttpError } from './http.ts';

const NET_CODES: Record<string, string> = {
  ENOTFOUND: '找不到服务器（域名解析失败），请检查网络或代理。',
  EAI_AGAIN: '域名解析暂时失败，请稍后重试。',
  ECONNREFUSED: '服务器拒绝连接。',
  ECONNRESET: '连接被重置，可能是网络不稳定或被拦截。',
  ETIMEDOUT: '连接超时。',
  UND_ERR_CONNECT_TIMEOUT: '连接超时。',
  UND_ERR_HEADERS_TIMEOUT: '服务器响应超时。',
  UND_ERR_SOCKET: '连接中断。',
  CERT_HAS_EXPIRED: '对方网站的证书已过期。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证对方网站的证书。',
  ENOSPC: '磁盘空间不足。',
  EACCES: '没有写入权限，请换一个下载目录（@dir）。',
  EPERM: '没有权限操作这个文件，可能被其他程序占用。',
  EBUSY: '文件正被其他程序占用。',
};

const HTTP_TEXT: Record<number, string> = {
  400: '请求被拒绝（400），接口可能已变化。',
  401: '需要登录（401）。',
  403: '访问被拒绝（403）。可能需要登录、换网络，或链接已过期。',
  404: '没有找到（404）。',
  412: '被网站风控拦截（412），请稍后再试。',
  429: '请求太频繁（429），请稍后再试。',
  451: '因法律原因不可用（451）。',
  500: '网站出错了（500）。',
  502: '网站网关错误（502）。',
  503: '网站暂时不可用（503）。',
  504: '网站网关超时（504）。',
};

function codeOf(err: unknown): string | undefined {
  for (let e = err as { code?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === 'string') return e.code;
  }
  return undefined;
}

/**
 * A message a person can act on. Errors already written for users (Chinese text from our
 * providers) pass through; low-level network and HTTP errors are translated.
 */
export function explainError(err: unknown): string {
  if (err instanceof HttpError) return HTTP_TEXT[err.status] ?? (err.message.startsWith('HTTP') ? `网站返回错误 ${err.status}。` : err.message);
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === 'TimeoutError') return '请求超时，请检查网络或稍后重试。';
  const code = codeOf(err);
  if (code && NET_CODES[code]) return NET_CODES[code]!;
  const msg = e?.message ?? String(err);
  if (/fetch failed|network|socket hang up/i.test(msg)) return '网络连接失败，请检查网络或代理。';
  if (/Unexpected token .* JSON|is not valid JSON/i.test(msg)) return '网站返回了无法解析的内容，接口可能已变化。';
  return msg;
}
