import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';

/** Every file under a folder, with its path inside the folder. */
async function walk(dir: string, root = dir): Promise<{ path: string; name: string }[]> {
  const out: { path: string; name: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else if (entry.isFile()) out.push({ path: full, name: relative(root, full).replace(/\\/g, '/') });
  }
  return out;
}

/**
 * A folder (a multi-file torrent, a book's chapters …) as one zip, streamed while it's built.
 * Files are stored, not compressed: they are media, and the transfer starts at once.
 */
export async function zipFolder(dir: string): Promise<Readable> {
  const files = await walk(dir);
  const top = basename(dir);
  const out = new Readable({ read() {} });
  const zip = new Zip((err, chunk, final) => {
    if (err) return out.destroy(err);
    out.push(Buffer.from(chunk));
    if (final) out.push(null);
  });
  void (async () => {
    try {
      for (const f of files) {
        const entry = new ZipPassThrough(`${top}/${f.name}`);
        entry.mtime = (await stat(f.path)).mtime;
        zip.add(entry);
        for await (const piece of createReadStream(f.path)) entry.push(piece as Uint8Array);
        entry.push(new Uint8Array(0), true);
      }
      zip.end();
    } catch (err) {
      out.destroy(err as Error);
    }
  })();
  return out;
}

/** `attachment` with the name in both forms browsers understand. */
export function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
