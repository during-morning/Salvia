import { createHash } from 'node:crypto';

// Constants of QQ Music's "zzc" request signature (web player, musics.fcg?sign=…).
const HEAD = [23, 14, 6, 36, 16, 7, 19];
const TAIL = [16, 1, 32, 12, 19, 27, 8, 5];
const MASK = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];

/**
 * zzc signature of a request body: picks characters of the upper-case SHA-1 hex at fixed positions
 * around a base64 of the digest XOR-ed with a fixed mask.
 */
export function zzcSign(body: string): string {
  const hex = createHash('sha1').update(body).digest('hex').toUpperCase();
  const pick = (idx: number[]) => idx.map((i) => hex[i]).join('');
  const mixed = Buffer.from(MASK.map((m, i) => m ^ parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
  const middle = mixed.toString('base64').replace(/[\\/+=]/g, '');
  return `zzc${pick(HEAD)}${middle}${pick(TAIL)}`.toLowerCase();
}
