import { api, type Task } from '../api.ts';

const LABEL: Record<Task['status'], string> = {
  queued: '排队中',
  running: '',
  paused: '已暂停',
  done: '完成',
  error: '失败',
  canceled: '已取消',
};

export function TaskRow({ t, server }: { t: Task; server: boolean }) {
  const pct = t.progress >= 0 ? Math.round(t.progress * 100) : null;
  const live = t.status === 'running' || t.status === 'queued' || t.status === 'paused';
  const info =
    t.status === 'running'
      ? [pct !== null ? `${pct}%` : '', t.speed ? speed(t.speed) : ''].filter(Boolean).join(' · ')
      : t.status === 'error'
        ? (t.error ?? LABEL.error)
        : t.status === 'done'
          ? server
            ? '已完成 · 正在发送到本机（收完后服务端会删除这份文件）'
            : (t.outputPath ?? LABEL.done)
          : LABEL[t.status];
  return (
    <li className={`task ${t.status}`}>
      <div className="row">
        <span className="title">{t.title}</span>
        <span className="acts">
          {live && <button onClick={() => api.pause(t.id)}>{t.status === 'paused' ? '继续' : '暂停'}</button>}
          {t.status === 'done' && t.outputPath && (
            <a className="save" href={api.fileUrl(t.id)} download>
              保存到本机
            </a>
          )}
          {t.status === 'done' && t.outputPath && !server && (
            <button onClick={() => confirm(`删除文件？ ${t.outputPath}`) && api.deleteFile(t.id)}>删除文件</button>
          )}
          <button onClick={() => api.remove(t.id)}>{live ? '取消并移除' : '移除'}</button>
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="meta" title={info}>
        {info}
      </div>
    </li>
  );
}

function speed(bps: number): string {
  const mb = bps / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}
