import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { DOMElement } from 'ink';
import type { MouseEvent } from './mouse.ts';

/**
 * Hit-testing for mouse events. Elements register an area (a Box ref plus handlers); on each event
 * the absolute rectangle of every area is read from Ink's Yoga layout and the topmost, innermost
 * match receives it. Layers let dialogs sit above the screen behind them.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AreaHandlers {
  /** Local coordinates are relative to the area's top-left cell. */
  onClick?: (local: { x: number; y: number }, e: MouseEvent) => void;
  onRightClick?: (local: { x: number; y: number }, e: MouseEvent) => void;
  onWheel?: (direction: 1 | -1, e: MouseEvent) => void;
  onHover?: (local: { x: number; y: number }, e: MouseEvent) => void;
  onLeave?: () => void;
  /** Higher layers win; areas below an open dialog get nothing. */
  layer?: number;
}

interface Area {
  ref: RefObject<DOMElement | null>;
  handlers: AreaHandlers;
}

interface YogaLike {
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
}

/** Absolute cell rectangle of an Ink element (sums Yoga offsets up the tree). */
export function rectOf(el: DOMElement | null | undefined): Rect | undefined {
  const node = (el as { yogaNode?: YogaLike } | null)?.yogaNode;
  if (!el || !node) return undefined;
  let x = 0;
  let y = 0;
  for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
    const yn = (n as { yogaNode?: YogaLike }).yogaNode;
    if (!yn) continue;
    x += yn.getComputedLeft();
    y += yn.getComputedTop();
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(node.getComputedWidth()), height: Math.round(node.getComputedHeight()) };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** Drag-to-select (see select.ts): a press that moves becomes a selection instead of a click. */
export interface DragHandler {
  start(p: { x: number; y: number }): void;
  move(p: { x: number; y: number }): void;
  end(p: { x: number; y: number }): void;
  /** A plain click: drop any selection shown. */
  clear(): void;
}

export class HitRegistry {
  private areas = new Set<Area>();
  private hovered?: Area;
  /** The left button is down here; a click fires on release unless it became a drag. */
  private press?: { x: number; y: number; dragging: boolean };
  drag?: DragHandler;
  /** Highest layer currently registered; areas below it are inert (modal dialogs). */
  private topLayer(): number {
    let top = 0;
    for (const a of this.areas) top = Math.max(top, a.handlers.layer ?? 0);
    return top;
  }

  add(area: Area): () => void {
    this.areas.add(area);
    return () => {
      this.areas.delete(area);
      if (this.hovered === area) this.hovered = undefined;
    };
  }

  /** Areas under the point on the active layer, innermost (smallest) first. */
  private hits(x: number, y: number): { area: Area; rect: Rect }[] {
    const layer = this.topLayer();
    const out: { area: Area; rect: Rect }[] = [];
    for (const area of this.areas) {
      if ((area.handlers.layer ?? 0) !== layer) continue;
      const rect = rectOf(area.ref.current);
      if (rect && inside(rect, x, y)) out.push({ area, rect });
    }
    return out.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
  }

  dispatch(e: MouseEvent): void {
    const hits = this.hits(e.x, e.y);
    const local = (rect: Rect) => ({ x: e.x - rect.x, y: e.y - rect.y });
    if (e.kind === 'wheel-up' || e.kind === 'wheel-down') {
      const hit = hits.find((h) => h.area.handlers.onWheel);
      hit?.area.handlers.onWheel!(e.kind === 'wheel-up' ? -1 : 1, e);
      return;
    }
    // No hover while the button is held: a drag would re-render rows under the selection.
    if (e.kind === 'down' || (e.kind === 'move' && !this.press)) {
      const hit = hits.find((h) => h.area.handlers.onHover || h.area.handlers.onLeave);
      if (this.hovered && this.hovered !== hit?.area) this.hovered.handlers.onLeave?.();
      this.hovered = hit?.area;
      if (hit) hit.area.handlers.onHover?.(local(hit.rect), e);
    }
    if (e.kind === 'down' && e.button === 'left') {
      this.drag?.clear();
      this.press = { x: e.x, y: e.y, dragging: false };
      return;
    }
    if (e.kind === 'move' && e.button === 'left' && this.press && this.drag) {
      if (!this.press.dragging && (e.x !== this.press.x || e.y !== this.press.y)) {
        this.press.dragging = true;
        this.drag.start(this.press);
      }
      if (this.press.dragging) this.drag.move(e);
      return;
    }
    if (e.kind === 'up' && e.button !== 'right' && this.press) {
      const press = this.press;
      this.press = undefined;
      if (press.dragging) return this.drag?.end(e);
      // A click: where the button went down.
      const hit = this.hits(press.x, press.y).find((h) => h.area.handlers.onClick);
      if (hit) hit.area.handlers.onClick!({ x: press.x - hit.rect.x, y: press.y - hit.rect.y }, { ...e, x: press.x, y: press.y, kind: 'down' });
    }
    if (e.kind === 'down' && e.button === 'right') {
      const hit = hits.find((h) => h.area.handlers.onRightClick);
      if (hit) hit.area.handlers.onRightClick!(local(hit.rect), e);
    }
  }
}

const HitContext = createContext<HitRegistry | null>(null);

export function HitProvider({ registry, children }: { registry: HitRegistry; children: ReactNode }) {
  return <HitContext.Provider value={registry}>{children}</HitContext.Provider>;
}

/** Register `ref` as a mouse area. Handlers may change every render. */
export function useMouseArea(ref: RefObject<DOMElement | null>, handlers: AreaHandlers): void {
  const registry = useContext(HitContext);
  const area = useRef<Area>({ ref, handlers });
  area.current.handlers = handlers;
  useEffect(() => registry?.add(area.current), [registry]);
}
