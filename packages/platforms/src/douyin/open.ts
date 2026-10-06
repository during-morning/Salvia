import { join } from 'node:path';
import { formatBytes, formatDuration, safeName, type Context, type PickItem } from '@salvia/core';
import { downloadFile } from '@salvia/media';
import { count } from '@salvia/video';
import { DOUYIN_HEADERS, douyinPost, douyinUserPosts, filesOf, parseDouyin, type Aweme, type DouyinFile } from './api.ts';

/** 抖音 links: a post's video qualities / images / music, or a creator's latest posts. */
function enqueueDouyin(ctx: Context, f: DouyinFile, title: string, out: string): void {
  ctx.enqueue({
    kind: 'video',
    title,
    host: 'douyin',
    async run(signal, report) {
      await downloadFile(f.url, out, {
        signal,
        headers: DOUYIN_HEADERS,
        mirrors: f.mirrors,
        size: f.size,
        onProgress: (done, total, speed) => report({ progress: total ? done / total : -1, speed }),
      });
      return out;
    },
  });
}

const postName = (a: Aweme) => safeName(`${a.author?.nickname ?? '抖音'} - ${(a.desc ?? '').replace(/#\S+/g, '').trim().slice(0, 50) || a.aweme_id}`);

/** Best quality of a post: the video, or all its images (in a folder). */
function enqueueBest(ctx: Context, a: Aweme): number {
  const { video, images } = filesOf(a);
  const name = postName(a);
  if (video[0]) {
    enqueueDouyin(ctx, video[0], `${name} · ${video[0].label}`, join(ctx.config.downloadDir, `${name}.mp4`));
    return 1;
  }
  images.forEach((img, i) => enqueueDouyin(ctx, img, `${name} · ${img.label}`, join(ctx.config.downloadDir, name, `${String(i + 1).padStart(2, '0')}.${img.ext}`)));
  return images.length;
}

function showDouyinPost(ctx: Context, a: Aweme): void {
  const { video, images, music } = filesOf(a);
  const name = postName(a);
  const st = a.statistics;
  ctx.status([a.author?.nickname, (a.desc ?? '').slice(0, 60), st?.digg_count ? `${count(st.digg_count)} 赞` : '', images.length ? `${images.length} 张图片` : ''].filter(Boolean).join(' · '), 'idle');
  const dir = ctx.config.downloadDir;
  const items: PickItem[] = [
    ...video.map((f) => ({
      id: f.id,
      title: f.label,
      meta: f.size ? formatBytes(f.size) : '无水印',
      pick: () => {
        enqueueDouyin(ctx, f, `${name} · ${f.label}`, join(dir, `${name}.mp4`));
        ctx.status(`已加入下载：${f.label}`, 'ok');
      },
    })),
    ...(images.length > 1
      ? [{ id: 'images', title: `全部 ${images.length} 张图片`, meta: '无水印', pick: () => ctx.status(`已加入 ${enqueueBest(ctx, a)} 个下载`, 'ok') }]
      : []),
    ...images.map((img, i) => ({
      id: img.id,
      title: `图片 · ${img.label}`,
      meta: img.ext,
      pick: () => {
        enqueueDouyin(ctx, img, `${name} · ${img.label}`, join(dir, name, `${String(i + 1).padStart(2, '0')}.${img.ext}`));
        ctx.status(`已加入下载：${img.label}`, 'ok');
      },
    })),
    ...(music
      ? [
          {
            id: 'music',
            title: music.label,
            pick: () => {
              enqueueDouyin(ctx, music, `${name} · 背景音乐`, join(dir, `${name}.mp3`));
              ctx.status('已加入下载：背景音乐', 'ok');
            },
          },
        ]
      : []),
  ];
  if (!items.length) return ctx.status('这个作品没有可下载的内容。', 'error');
  ctx.items(items);
}

export async function openDouyin(ctx: Context, input: string): Promise<void> {
  ctx.status('解析抖音链接');
  const ref = await parseDouyin(input, ctx.signal);
  if (ref.kind === 'post') {
    ctx.status('读取抖音作品（首次可能要十几秒）');
    return showDouyinPost(ctx, await douyinPost(ref.id, ctx.signal));
  }
  ctx.status('读取抖音主页的作品（首次可能要十几秒）');
  const { name, posts } = await douyinUserPosts(ref.secUid, ctx.signal);
  ctx.status(`${name} · 最近 ${posts.length} 个作品`, 'idle');
  ctx.items(
    [
      { id: 'all', title: `全部 ${posts.length} 个作品 · 最高画质`, pick: () => ctx.status(`已加入 ${posts.reduce((n, a) => n + enqueueBest(ctx, a), 0)} 个下载`, 'ok') },
      ...posts.map((a) => ({
        id: `dy:${a.aweme_id}`,
        title: (a.desc ?? '').trim() || a.aweme_id,
        meta: a.images?.length ? `${a.images.length} 张图片` : a.video?.duration ? formatDuration(a.video.duration / 1000) : undefined,
        cells: [(a.desc ?? '').trim() || a.aweme_id, a.images?.length ? `图文 ${a.images.length}` : '视频', a.video?.duration && !a.images?.length ? formatDuration(a.video.duration / 1000) : '', count(a.statistics?.digg_count ?? 0)],
        selectable: true,
        pick: () => showDouyinPost(ctx, a),
      })),
    ],
    {
      columns: [
        { title: '作品', flex: 3 },
        { title: '类型', width: 8 },
        { title: '时长', width: 7, align: 'right' },
        { title: '点赞', width: 8, align: 'right' },
      ],
      batch: {
        label: '下载选中',
        run(ids) {
          const picked = ids.map((id) => posts.find((a) => `dy:${a.aweme_id}` === id)).filter((a): a is Aweme => !!a);
          ctx.status(`已加入 ${picked.reduce((n, a) => n + enqueueBest(ctx, a), 0)} 个下载`, 'ok');
        },
      },
    },
  );
}
