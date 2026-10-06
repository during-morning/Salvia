import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

// Fixed key of the NetEase desktop client's "eapi" transport (see Suxiaoqinx/Netease_url, MIT).
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const SEP = '-36cd479b6b5-';

/**
 * Encrypt an eapi request body. `path` is the API path with `/api/` (not `/eapi/`), e.g.
 * "/api/song/enhance/player/url/v1". Returns the hex string sent as the `params` form field.
 */
export function eapiEncrypt(path: string, data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex');
  const cipher = createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([cipher.update(`${path}${SEP}${text}${SEP}${digest}`), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

/** Inverse of eapiEncrypt, for tests and debugging. */
export function eapiDecrypt(hex: string): { path: string; text: string; digest: string } {
  const decipher = createDecipheriv('aes-128-ecb', EAPI_KEY, null);
  const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString();
  const [path = '', text = '', digest = ''] = plain.split(SEP);
  return { path, text, digest };
}
