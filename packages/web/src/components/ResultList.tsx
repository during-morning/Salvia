import type { Item } from '../api.ts';

/** The results under the composer; unavailable ones say why (or that a login helps). */
export function ResultList({ items, sel, onHover, onPick }: { items: Item[]; sel: number; onHover: (i: number) => void; onPick: (id: string) => void }) {
  return (
    <ul className="rows" role="listbox">
      {items.map((it, i) => (
        <li
          key={it.id}
          role="option"
          aria-selected={i === sel}
          aria-disabled={it.disabled}
          data-locked={it.locked ? '' : undefined}
          onMouseEnter={() => !it.disabled && onHover(i)}
          onClick={() => !it.disabled && onPick(it.id)}
        >
          <span className="mark" aria-hidden>
            {i === sel ? '[*]' : '[ ]'}
          </span>
          <span className="title">{it.title}</span>
          {(it.meta || it.locked) && <span className="meta">{it.locked ? [it.locked.site ? '需登录' : it.locked.reason, it.meta].filter(Boolean).join(' · ') : it.meta}</span>}
        </li>
      ))}
    </ul>
  );
}
