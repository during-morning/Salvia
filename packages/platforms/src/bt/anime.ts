import { FatalError, formatBytes, getText, type Context, type ListOptions, type PickItem } from '@salvia/core';
import type { AnimeSource } from '@salvia/anime';
import { btDownload, btFiles } from './client.ts';
import { infoHash, parseRelease, searchBt, type BtResource } from './sources.ts';

const BT_COLUMNS = [
  { title: '标题', flex: 4 },
  { title: '字幕组', flex: 1 },
  { title: '集数', width: 6 },
  { title: '画质', width: 6 },
  { title: '字幕', width: 9 },
  { title: '大小', width: 9, align: 'right' as const },
  { title: '日期', width: 6 },
  { title: '来源', width: 8 },
];

const shortDate = (ms?: number) => (ms ? new Date(ms).toISOString().slice(5, 10) : '');
const isVideo = (name: string) => /\.(mkv|mp4|avi|ts|m2ts|webm|mov|flv|rmvb)$/i.test(name);

function enqueueBt(ctx: Context, r: BtResource, files: number[] | 'all', label: string): void {
  ctx.enqueue({
    kind: 'video',
    title: label,
    host: 'bt',
    run: (signal, report) => btDownload(r, ctx.config.downloadDir, files, signal, report),
  });
}

/** A release's files (from its metadata): all, or one at a time. */
async function showBtFiles(ctx: Context, r: BtResource): Promise<void> {
  ctx.status(`读取种子信息：${r.title}`);
  const { name, files } = await btFiles(r, ctx.config.downloadDir, ctx.signal);
  const total = files.reduce((a, f) => a + f.length, 0);
  ctx.status(`${name} · ${files.length} 个文件 · ${formatBytes(total)}（BT 下载，完成后即停止分享）`, 'idle');
  const sorted = [...files].sort((a, b) => Number(isVideo(b.name)) - Number(isVideo(a.name)) || a.path.localeCompare(b.path, 'zh'));
  ctx.items([
    ...(files.length > 1
      ? [{ id: 'all', title: `全部 ${files.length} 个文件`, meta: formatBytes(total), pick: () => (enqueueBt(ctx, r, 'all', name), ctx.status('已加入下载', 'ok')) }]
      : []),
    ...sorted.map((f) => ({
      id: `f:${f.index}`,
      title: f.path,
      meta: formatBytes(f.length),
      pick: () => {
        enqueueBt(ctx, r, [f.index], f.name);
        ctx.status(`已加入下载：${f.name}`, 'ok');
      },
    })),
  ]);
}

function btItems(ctx: Context, list: BtResource[]): { items: PickItem[]; opts: ListOptions } {
  return {
    items: list.map((r, i) => ({
      id: `bt:${i}`,
      title: r.title,
      meta: [r.group, r.episode ? (/^\d/.test(r.episode) ? `第 ${r.episode}` : r.episode) : '', r.resolution, r.size ? formatBytes(r.size) : '', r.source].filter(Boolean).join(' · '),
      cells: [r.title, r.group ?? '', r.episode ?? '', r.resolution ?? '', r.subtitle ?? '', r.size ? formatBytes(r.size) : '', shortDate(r.date), r.source],
      selectable: true,
      pick: () => showBtFiles(ctx, r),
    })),
    opts: {
      columns: BT_COLUMNS,
      // Checked releases, every file in each.
      batch: {
        label: '下载选中',
        run(ids) {
          const picked = ids.map((id) => list[Number(id.slice(3))]).filter((r): r is BtResource => !!r);
          for (const r of picked) enqueueBt(ctx, r, 'all', r.title);
          ctx.status(`已加入 ${picked.length} 个下载`, 'ok');
        },
      },
    },
  };
}

/** Search the BT indexes under each name a title goes by (Chinese, original). */
async function btFor(ctx: Context, names: string[]): Promise<{ resources: BtResource[]; failed: string[] }> {
  const results = await Promise.all([...new Set(names.filter(Boolean))].slice(0, 2).map((n) => searchBt(n, ctx.signal)));
  const seen = new Set<string>();
  const resources = results
    .flatMap((r) => r.resources)
    .filter((r) => {
      const key = r.hash ?? r.title;
      return !seen.has(key) && !!seen.add(key);
    })
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return { resources, failed: [...new Set(results.flatMap((r) => r.failed))] };
}

const BT_NOTE = 'BT 资源来自动漫花园 / Mikan / ACG.RIP 的索引，下载时会向其他人分享片段，完成后停止';

/** BT releases from 动漫花园 / Mikan / ACG.RIP, under each name a title goes by. */
export const btAnime: AnimeSource = {
  id: 'bt',
  name: 'BT',
  aliases: ['torrent', '种子'],
  async offers(title, ctx) {
    const { resources, failed } = await btFor(ctx, title.names);
    if (!resources.length) return failed.length === 3 ? undefined : { items: [] };
    const { items, opts } = btItems(ctx, resources);
    return {
      items,
      columns: opts.columns,
      batch: opts.batch,
      summary: [`${resources.length} 个 BT 资源`, failed.length ? `${failed.join('、')} 无法访问` : ''].filter(Boolean).join(' · '),
      note: BT_NOTE,
    };
  },
};

const pageTitle = (html: string) =>
  (html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '')
    .replace(/\s*[-|_]\s*(動漫花園資源網|Mikan Project|ACG\.RIP)[\s\S]*$/i, '')
    .replace(/&amp;/g, '&')
    .trim();

/**
 * A magnet link, or a release page on 动漫花园 / Mikan / ACG.RIP (they name the torrent or its
 * magnet): its files, to download through the BT engine.
 */
export async function openRelease(ctx: Context, input: string): Promise<void> {
  ctx.status('读取资源信息');
  let r: BtResource | undefined;
  if (/^magnet:/i.test(input)) {
    const name = new URLSearchParams(input.slice(input.indexOf('?') + 1)).get('dn') ?? '';
    const hash = infoHash(input);
    r = { title: name || hash || '磁力链接', source: '动漫花园', magnet: input, hash, ...parseRelease(name) };
  } else {
    const page = await getText(input, { signal: ctx.signal });
    const title = pageTitle(page);
    const acg = input.match(/acg\.rip\/t\/(\d+)/)?.[1];
    // The .torrent file when the page links one (instant file list), else its magnet.
    const torrent = acg ? `https://acg.rip/t/${acg}.torrent` : page.match(/href="([^"]+\.torrent)"/)?.[1];
    const magnet = page.match(/magnet:\?xt=urn:btih:[0-9a-zA-Z]{32,40}[^"'<\s]*/)?.[0]?.replace(/&amp;/g, '&');
    if (!torrent && !magnet) throw new FatalError('这个页面上没有找到种子或磁力链接。');
    r = {
      title: title || '资源',
      source: /mikanani/.test(input) ? 'Mikan' : acg ? 'ACG.RIP' : '动漫花园',
      page: input,
      torrent: torrent ? new URL(torrent.replace(/&amp;/g, '&'), input).href : undefined,
      magnet,
      hash: magnet ? infoHash(magnet) : undefined,
      ...parseRelease(title),
    };
  }
  await showBtFiles(ctx, r);
}
