// City input: arrow keys/WASD walk (Shift runs), click/tap walks to point (A*), E/Enter near a
// door, drag pans camera (which stops following player until walking again), wheel/pinch and +/− zoom.
// Keyboard is ignored when input, dialog, or popover has focus (Settings remains usable in city).
import { modalOpen } from '../input';
import type { Camera } from '../camera';
import type { MoveIntent } from './players';

export interface CityInputHandlers {
  /** Scene is on screen (otherwise, no-op). */
  active(): boolean;
  hover(sx: number, sy: number, inside: boolean): void;
  /** Click or tap without dragging (canvas CSS px). */
  click(sx: number, sy: number, mods: { shift: boolean }): void;
  /** User interacted with camera: stops following player. */
  interact(): void;
  zoomStep(steps: number, sx?: number, sy?: number): void;
  /** E or Enter. */
  use(): void;
  /** 0: returns camera to player. */
  recenter(): void;
  /** A movement key was pressed. */
  moved(): void;
}

const DRAG_THRESHOLD = 6;

const MOVE_KEYS: Readonly<Record<string, [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
};

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? '') || el.getAttribute?.('role') === 'radio');
}

/** Pressed keys → movement intent (pure, testable). */
export function intentFrom(keys: ReadonlySet<string>, shift: boolean): MoveIntent {
  let dx = 0;
  let dy = 0;
  for (const k of keys) {
    const v = MOVE_KEYS[k];
    if (!v) continue;
    dx += v[0];
    dy += v[1];
  }
  return { dx: Math.sign(dx), dy: Math.sign(dy), run: shift };
}

/** Normalizes key (uppercase WASD with Shift, layouts that send "W"). */
export function moveKeyOf(e: { key: string; code?: string }): string | null {
  if (MOVE_KEYS[e.key]) return e.key;
  const low = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (MOVE_KEYS[low]) return low;
  if (e.code === 'KeyW') return 'w';
  if (e.code === 'KeyA') return 'a';
  if (e.code === 'KeyS') return 's';
  if (e.code === 'KeyD') return 'd';
  return null;
}

export class CityInput {
  private readonly keys = new Set<string>();
  private shift = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private downX = 0;
  private downY = 0;
  private dragging = false;
  private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
  private wheelAcc = 0;
  private wheelSettle: ReturnType<typeof setTimeout> | null = null;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly h: CityInputHandlers,
  ) {
    canvas.style.touchAction = 'none';
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement | Document, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onCancel(e));
    on(canvas, 'pointerleave', () => this.h.hover(0, 0, false));
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => this.clearKeys());
    on(document, 'visibilitychange', () => this.clearKeys());
  }

  /** Current intent from pressed keys. */
  intent(): MoveIntent {
    return intentFrom(this.keys, this.shift);
  }

  clearKeys(): void {
    this.keys.clear();
    this.shift = false;
  }

  destroy(): void {
    for (const f of this.off.splice(0)) f();
    if (this.wheelSettle) clearTimeout(this.wheelSettle);
    this.clearKeys();
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.key === 'Shift') this.shift = down;
    else if (typeof e.getModifierState === 'function') this.shift = e.getModifierState('Shift');
    if (!down) {
      const k = moveKeyOf(e);
      if (k) this.keys.delete(k);
      return;
    }
    if (!this.h.active() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target) || modalOpen(e.target as HTMLElement | null)) return;
    const k = moveKeyOf(e);
    if (k) {
      e.preventDefault();
      this.keys.add(k);
      this.h.moved();
      return;
    }
    switch (e.key) {
      case 'e':
      case 'E':
      case 'Enter':
        if (e.key === 'Enter' && (e.target as HTMLElement | null)?.closest?.('button, a')) return;
        e.preventDefault();
        this.h.use();
        return;
      case '+':
      case '=':
        e.preventDefault();
        this.h.zoomStep(1);
        return;
      case '-':
      case '_':
        e.preventDefault();
        this.h.zoomStep(-1);
        return;
      case '0':
        e.preventDefault();
        this.h.recenter();
        return;
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
    if (this.pointers.size === 1) {
      this.downX = p.x;
      this.downY = p.y;
      this.dragging = false;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.camera.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.dragging = true;
      this.h.interact();
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse') this.h.hover(p.x, p.y, true);
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      this.camera.panBy(cx - this.pinch.cx, cy - this.pinch.cy);
      this.camera.zoomAt(this.pinch.zoom * (dist / this.pinch.dist), cx, cy, Date.now(), false);
      this.pinch.cx = cx;
      this.pinch.cy = cy;
      return;
    }
    if (!this.dragging && Math.hypot(p.x - this.downX, p.y - this.downY) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.canvas.style.cursor = 'grabbing';
      this.h.interact();
    }
    if (this.dragging) this.camera.panBy(p.x - prev.x, p.y - prev.y);
  }

  private onUp(e: PointerEvent): void {
    const p = this.local(e);
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      this.camera.settle(Date.now());
      return;
    }
    if (this.pointers.size > 0) return;
    this.canvas.style.cursor = '';
    if (this.dragging) {
      this.dragging = false;
      return;
    }
    this.h.click(p.x, p.y, { shift: e.shiftKey });
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) this.dragging = false;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (e.ctrlKey) {
      // trackpad pinch: continuous zoom, snaps to level on settle
      this.camera.zoomAt(this.camera.zoom * Math.exp(-delta * 0.012), p.x, p.y, Date.now(), false);
      if (this.wheelSettle) clearTimeout(this.wheelSettle);
      this.wheelSettle = setTimeout(() => this.camera.settle(Date.now()), 180);
      return;
    }
    this.wheelAcc += delta;
    if (Math.abs(this.wheelAcc) >= 50) {
      this.h.zoomStep(this.wheelAcc < 0 ? 1 : -1, p.x, p.y);
      this.wheelAcc = 0;
    }
  }
}
