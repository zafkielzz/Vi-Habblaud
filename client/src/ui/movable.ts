// Movable windows: dragging the handle detaches panel from default position (becomes "floating"); pulling edges or
// corners resizes (and also detaches); double-clicking the handle redocks it. Position and size persist in browser
// (localStorage, per panel). On narrow screens panels remain fixed.
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

const DRAG_THRESHOLD = 4;
/** How much of window must remain visible on screen. */
const KEEP_VISIBLE = 80;
const MIN_W = 300;
const MIN_H = 160;

/** Resizable edges and corners: n/s resize top/bottom, e/w resize right/left. */
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MovableOptions {
  /** Key in localStorage. */
  key: string;
  /** Can detach now? (false on narrow screens). */
  enabled?: () => boolean;
  /** Called when panel floats or docks. */
  onChange?: (floating: boolean) => void;
  /** Called after moving or resizing (e.g. refitting a terminal). */
  onMove?: () => void;
}

export class Movable {
  private box: Box | null = null;
  private max = false;
  private sizing: { id: number; edge: Edge; sx: number; sy: number; start: Box } | null = null;
  private drag: { id: number; dx: number; dy: number; sx: number; sy: number; moving: boolean } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private el: HTMLElement,
    handle: HTMLElement,
    private opts: MovableOptions,
  ) {
    handle.classList.add('ui-move-handle');
    handle.addEventListener('pointerdown', (e) => this.onDown(e, handle));
    handle.addEventListener('pointermove', (e) => this.onMove(e));
    handle.addEventListener('pointerup', (e) => this.onUp(e, handle));
    handle.addEventListener('pointercancel', (e) => this.onUp(e, handle));
    handle.addEventListener('dblclick', (e) => {
      if (interactive(e.target)) return;
      if (this.max) this.toggleMaximize();
      else this.dock();
    });
    for (const edge of EDGES) el.append(this.edgeHandle(edge));
    const saved = load(opts.key);
    if (saved && this.allowed()) this.float(saved, false);
    addEventListener('resize', () => {
      // Narrow screen: redocks without forgetting saved position, restored when screen widens again.
      if (!this.allowed()) this.unfloat();
      else if (this.box) this.apply(this.box);
      else {
        const saved = load(opts.key);
        if (saved) this.float(saved, true);
      }
    });
    // Resized via corner handle (resize: both): persists new size.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (!this.box || this.max || this.drag?.moving || this.sizing || this.el.hidden) return;
        const w = this.el.offsetWidth;
        const h = this.el.offsetHeight;
        if (!w || !h || (w === this.box.w && h === this.box.h)) return;
        this.box = { ...this.box, w, h };
        this.scheduleSave();
        this.opts.onMove?.();
      }).observe(el);
    }
  }

  get floating(): boolean {
    return this.box !== null;
  }

  /** Full Habblaud screen (on top of everything; not draggable). */
  get maximized(): boolean {
    return this.max;
  }

  toggleMaximize(force?: boolean): void {
    const next = force ?? !this.max;
    if (next === this.max) return;
    this.max = next;
    this.el.classList.toggle('is-max', next);
    this.opts.onMove?.();
  }

  /**
   * Re-reads saved position (another window with same key may have changed) and applies: windows sharing
   * the same slot (both terminals) stay aligned.
   */
  restore(): void {
    const saved = load(this.opts.key);
    if (saved && this.allowed()) this.float(saved, false);
    else if (this.box) {
      this.box = null;
      this.el.classList.remove('is-floating');
      for (const p of ['left', 'top', 'width', 'height']) this.el.style.removeProperty(p);
    }
  }

  /** Returns to default docked position (and forgets saved position). */
  dock(): void {
    if (!this.box) return;
    save(this.opts.key, null);
    this.unfloat();
  }

  /** Returns to default docked position without altering saved position. */
  private unfloat(): void {
    if (!this.box) return;
    // A pending save would write the stale box (or erase the saved one).
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.box = null;
    this.el.classList.remove('is-floating');
    for (const p of ['left', 'top', 'width', 'height']) this.el.style.removeProperty(p);
    this.opts.onChange?.(false);
    this.opts.onMove?.();
  }

  /** Invisible handle on edge/corner: dragging resizes window (detaching it if docked). */
  private edgeHandle(edge: Edge): HTMLElement {
    const g = document.createElement('div');
    g.className = `ui-resize ui-resize--${edge}`;
    g.setAttribute('aria-hidden', 'true');
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.max || !this.allowed()) return;
      e.preventDefault();
      e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      if (!this.box) this.float({ x: r.left, y: r.top, w: r.width, h: r.height }, true);
      this.sizing = { id: e.pointerId, edge, sx: e.clientX, sy: e.clientY, start: { ...this.box! } };
      this.el.classList.add('is-resizing');
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      const z = this.sizing;
      if (!z || z.id !== e.pointerId) return;
      const dx = e.clientX - z.sx;
      const dy = e.clientY - z.sy;
      const b = { ...z.start };
      if (edge.includes('e')) b.w = Math.max(MIN_W, z.start.w + dx);
      if (edge.includes('s')) b.h = Math.max(MIN_H, z.start.h + dy);
      if (edge.includes('w')) {
        b.w = Math.max(MIN_W, z.start.w - dx);
        b.x = z.start.x + z.start.w - b.w;
      }
      if (edge.includes('n')) {
        // Stops at top limit: beyond it, bottom edge would push down.
        b.h = Math.max(MIN_H, Math.min(z.start.h - dy, z.start.y + z.start.h - this.minTop()));
        b.y = z.start.y + z.start.h - b.h;
      }
      this.apply(b);
    });
    const end = (e: PointerEvent) => {
      const z = this.sizing;
      if (!z || z.id !== e.pointerId) return;
      this.sizing = null;
      this.el.classList.remove('is-resizing');
      if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
      this.scheduleSave();
      this.opts.onMove?.();
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    return g;
  }

  private allowed(): boolean {
    return this.opts.enabled?.() ?? true;
  }

  private onDown(e: PointerEvent, handle: HTMLElement): void {
    if (e.button !== 0 || this.max || interactive(e.target) || !this.allowed()) return;
    const r = this.el.getBoundingClientRect();
    this.drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moving: false };
    handle.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moving) {
      if (Math.abs(e.clientX - d.sx) < DRAG_THRESHOLD && Math.abs(e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moving = true;
      const r = this.el.getBoundingClientRect();
      this.float({ x: r.left, y: r.top, w: r.width, h: r.height }, true);
      this.el.classList.add('is-dragging');
    }
    e.preventDefault();
    if (this.box) this.apply({ ...this.box, x: e.clientX - d.dx, y: e.clientY - d.dy });
  }

  private onUp(e: PointerEvent, handle: HTMLElement): void {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (!d.moving) return;
    this.el.classList.remove('is-dragging');
    this.scheduleSave();
    this.opts.onMove?.();
  }

  private float(b: Box, notify: boolean): void {
    const was = this.box !== null;
    this.el.classList.add('is-floating');
    this.apply(b);
    if (!was && notify) this.opts.onChange?.(true);
    else if (!was) queueMicrotask(() => this.opts.onChange?.(true));
  }

  /**
   * Top limit: right below the top bar, like docked panels. Above it, window header would be covered
   * and impossible to drag back (or close, in terminal).
   */
  private minTop(): number {
    const s = getComputedStyle(this.el);
    // --top-h is calc(--bar-h + --status-h): add the parts (a custom property is not resolved to one length).
    const px = (name: string) => parseFloat(s.getPropertyValue(name)) || 0;
    return px('--bar-h') + px('--status-h') + px('--gap');
  }

  /** Applies box, keeping a portion of window (and header) inside viewport. */
  private apply(b: Box): void {
    const w = Math.max(MIN_W, Math.min(b.w, innerWidth));
    const x = Math.min(innerWidth - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - w, b.x));
    // Top boundary takes precedence: in very short windows, header remains reachable.
    const y = Math.max(this.minTop(), Math.min(innerHeight - MIN_H, b.y));
    // Height shrinks so window does not exceed bottom edge.
    const h = Math.max(MIN_H, Math.min(b.h, innerHeight - y - 8));
    this.box = { x, y, w, h };
    const s = this.el.style;
    s.left = `${Math.round(x)}px`;
    s.top = `${Math.round(y)}px`;
    s.width = `${Math.round(w)}px`;
    s.height = `${Math.round(h)}px`;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => save(this.opts.key, this.box), 250);
  }
}

/** "Expand to full screen / restore" button for movable window (`get` returns its Movable). */
export function maximizeButton(get: () => Movable | undefined, onToggle?: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ui-icon-btn ui-icon-btn--sm ui-term__max';
  const sync = () => {
    const max = !!get()?.maximized;
    b.innerHTML = max ? ICONS.restore : ICONS.maximize;
    const label = max ? tr('Restore size') : tr('Expand to full screen');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(max));
  };
  b.addEventListener('click', () => {
    get()?.toggleMaximize();
    sync();
    onToggle?.();
  });
  sync();
  return b;
}

/** Click on button/input inside header does not drag. */
function interactive(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('button, a, input, select, textarea, [role="button"], kbd');
}

function load(key: string): Box | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Box> | null;
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return v as Box;
  } catch {
    // no storage
  }
  return null;
}

function save(key: string, b: Box | null): void {
  try {
    if (b) localStorage.setItem(key, JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
    else localStorage.removeItem(key);
  } catch {
    // no storage
  }
}
