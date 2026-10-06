import type { Item, Preview } from '../api.ts';

/** A result opened for its details, and the lists its pick produced while open. */
export interface Detail {
  item: Item;
  data?: Preview;
  error?: string;
  tab: number;
  seq: number;
  /** Lists seen while open: the results, then the download options the pick produced, then deeper ones. */
  keys: string[];
}

export function DetailPane({ p, onTab }: { p: Detail; onTab: (i: number) => void }) {
  const d = p.data;
  const section = d?.sections[Math.min(p.tab, d.sections.length - 1)];
  return (
    <section className="card detail" aria-label="详情">
      <header>
        <h2>{d?.title ?? p.item.title}</h2>
        {(d?.subtitle ?? p.item.meta) && <span className="muted">{d?.subtitle ?? p.item.meta}</span>}
      </header>
      {!d && !p.error && <p className="status busy">正在读取详情</p>}
      {p.error && <p className="status error">{p.error}</p>}
      {d && (
        <>
          {d.fields.length > 0 && (
            <dl>
              {d.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {d.sections.length > 0 && (
            <>
              <nav className="segmented" role="tablist">
                {d.sections.map((s, i) => (
                  <button key={s.title + i} role="tab" aria-selected={s === section} onClick={() => onTab(i)}>
                    {s.title}
                  </button>
                ))}
              </nav>
              <div className="text">{section?.text}</div>
            </>
          )}
        </>
      )}
    </section>
  );
}
