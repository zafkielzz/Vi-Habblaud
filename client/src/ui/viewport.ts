// Office free area: the part of the screen that no UI panel covers.
// Measures top bar, sidebar, drawer, and feed and notifies the world (setViewInsets) so overview
// and focus (agent, room, follow) frame only what is visible. The same area becomes CSS variables
// (--free-top/right/bottom/left) to position the empty state and notices.
//
// Interaction details:
// - the drawer opened by clicking the canvas only changes framing after the double-click window
//   (otherwise the camera moves between 1st and 2nd clicks and double-click misses the target); during this window the drawer
//   also lets clicks pass through to the canvas;
// - when selection was opened "with focus" (list, feed, notice, Center, double-click), focus is updated
//   on every free area change, until the user moves the camera.
import type { Selection, ViewInsets, WorldApi } from '../world/api';

/** Gap between panel border and framed content (CSS px). */
export const INSET_GAP = 8;
/** Double-click window: drawer opened by 1st click only changes framing after it. */
export const DBLCLICK_GUARD_MS = 380;
/** Minimum free area: on tiny screens panels give way to keep the world usable. */
export const MIN_FREE = 120;
/** World camera animation time (+ padding) before verifying whether agent is visible. */
const CAMERA_SETTLE_MS = 480;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 24;
const DRAG_PX = 6;
/** Standard and minimum width for notices (CSS px). */
const TOAST_W = 344;
const TOAST_MIN_W = 280;
const CAMERA_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'A', 'd', 'D', 'w', 'W', 's', 'S', '+', '=', '-', '_', '0', 'o', 'O']);

/** Final geometry of panels (without open/close transitions), in CSS px relative to viewport. */
export interface PanelGeometry {
  vw: number;
  vh: number;
  /** Bottom edge of top bar. */
  topBottom: number;
  /** Right edge of open sidebar. */
  sideRight: number;
  /** Left edge and top edge of open drawer. */
  drawerLeft: number;
  drawerTop: number;
  /** Drawer as bottom sheet (mobile) instead of right column. */
  drawerSheet: boolean;
  /** Height of open and collapsed feed, and its distance to the bottom edge. */
  feedOpenH: number;
  feedClosedH: number;
  feedMargin: number;
}

export interface PanelFlags {
  sidebar: boolean;
  feed: boolean;
  drawer: boolean;
  /** Narrow screen: sidebar becomes overlay drawer (with backdrop) and does not count as covered area. */
  narrow: boolean;
}

function shrinkPair(a: number, b: number, total: number): [number, number] {
  const free = total - a - b;
  if (free >= MIN_FREE || a + b <= 0) return [a, b];
  const room = Math.max(0, total - MIN_FREE);
  const k = room / (a + b);
  return [Math.floor(a * k), Math.floor(b * k)];
}

/** Margins covered by UI (pure: tested in viewport.test.ts). */
export function computeInsets(g: PanelGeometry, f: PanelFlags, gap = INSET_GAP): ViewInsets {
  const top = Math.max(0, g.topBottom) + gap;
  const left = f.sidebar && !f.narrow ? Math.max(0, g.sideRight) + gap : 0;
  const right = f.drawer && !g.drawerSheet ? Math.max(0, g.vw - g.drawerLeft) + gap : 0;
  const feedH = f.feed ? g.feedOpenH : g.feedClosedH;
  let bottom = feedH > 0 ? feedH + g.feedMargin + gap : 0;
  if (f.drawer && g.drawerSheet) bottom = Math.max(bottom, g.vh - g.drawerTop + gap);
  const [l, r] = shrinkPair(left, right, g.vw);
  const [t, b] = shrinkPair(top, bottom, g.vh);
  return { top: Math.round(t), right: Math.round(r), bottom: Math.round(b), left: Math.round(l) };
}

export function sameInsets(a: ViewInsets | null, b: ViewInsets): boolean {
  return !!a && Math.abs(a.top - b.top) < 1 && Math.abs(a.right - b.right) < 1 && Math.abs(a.bottom - b.bottom) < 1 && Math.abs(a.left - b.left) < 1;
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.id === b.id);
}

export interface FreeAreaPanels {
  root: HTMLElement;
  topbar: HTMLElement;
  sidebar: HTMLElement;
  drawer: HTMLElement;
  feed: HTMLElement;
}

/** `follow: 'option'` follows the current "follow selected" option; `true` = double click (always follows). */
type FocusIntent = { sel: NonNullable<Selection>; follow: boolean | 'option' };

const isCanvas = (t: EventTarget | null): t is HTMLCanvasElement => t instanceof HTMLCanvasElement;

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export class FreeArea {
  private applied: ViewInsets | null = null;
  private probe: HTMLElement;
  private probeFeedOpen: HTMLElement;
  private probeFeedClosed: HTMLElement;
  private probeGap: HTMLElement;
  private guardTimer: ReturnType<typeof setTimeout> | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private intent: FocusIntent | null = null;
  private toastPlace = '';
  private raf = 0;
  private down: { x: number; y: number; id: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };

  constructor(
    private world: WorldApi,
    private panels: FreeAreaPanels,
    private flags: () => PanelFlags,
  ) {
    // Invisible probe: resolves CSS variables (which change via media query) in px, without waiting for transitions.
    this.probeFeedOpen = document.createElement('span');
    this.probeFeedClosed = document.createElement('span');
    this.probeGap = document.createElement('span');
    this.probeFeedOpen.className = 'ui-probe__feed-open';
    this.probeFeedClosed.className = 'ui-probe__feed-closed';
    this.probeGap.className = 'ui-probe__gap';
    this.probe = document.createElement('div');
    this.probe.className = 'ui-probe';
    this.probe.setAttribute('aria-hidden', 'true');
    this.probe.append(this.probeFeedOpen, this.probeFeedClosed, this.probeGap);
    panels.root.append(this.probe);

    addEventListener('resize', () => this.schedule());
    // Feed width/position animates when opening/closing panels: reposition notices at end of transition.
    panels.feed.addEventListener('transitionend', (e) => {
      if (e.target === panels.feed) this.schedule();
    });
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => this.schedule());
      ro.observe(panels.topbar);
      ro.observe(this.probeFeedOpen);
      ro.observe(this.probeGap);
      ro.observe(panels.sidebar);
      ro.observe(panels.drawer);
    }
    this.watchCanvas();
  }

  /** Margins currently reported to the world. */
  get insets(): ViewInsets {
    return this.applied ?? { top: 0, right: 0, bottom: 0, left: 0 };
  }

  /** The drawer is within the double-click window (does not count as covered area yet). */
  get guarding(): boolean {
    return this.guardTimer !== null;
  }

  /** Recalculates on next frame (multiple events in the same frame coalesce into one measurement). */
  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.sync();
    });
  }

  /**
   * Measures, notifies the world, and updates CSS variables if anything changed.
   * `refocus: false` when the caller will focus immediately after (focus will already use new margins).
   */
  sync(opts: { refocus?: boolean } = {}): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    const f = this.flags();
    const g = this.measure();
    const insets = computeInsets(g, { ...f, drawer: f.drawer && !this.guarding });
    this.placeToasts(insets, g);
    if (sameInsets(this.applied, insets)) return;
    this.applied = insets;
    const s = this.panels.root.style;
    s.setProperty('--free-top', `${insets.top}px`);
    s.setProperty('--free-right', `${insets.right}px`);
    s.setProperty('--free-bottom', `${insets.bottom}px`);
    s.setProperty('--free-left', `${insets.left}px`);
    try {
      this.world.setViewInsets?.(insets);
    } catch (err) {
      console.error('[ui] setViewInsets failed', err);
    }
    if (opts.refocus !== false) this.refocus();
  }

  /**
   * Notices: bottom-right corner, beside the feed, when there is space there (outside framed building);
   * otherwise, right above the feed / details sheet. Always to the left of the drawer.
   */
  private placeToasts(ins: ViewInsets, g: PanelGeometry): void {
    const feed = this.panels.feed;
    const right = Math.max(g.feedMargin, ins.right);
    const beside = g.vw - right - (feed.offsetLeft + feed.offsetWidth) - g.feedMargin;
    const corner = !g.drawerSheet && beside >= TOAST_MIN_W;
    const bottom = corner ? g.feedMargin : ins.bottom;
    const width = corner ? Math.min(TOAST_W, beside) : Math.min(TOAST_W, Math.max(240, g.vw - right - Math.max(g.feedMargin, ins.left)));
    const key = `${bottom}|${width}`;
    if (key === this.toastPlace) return;
    this.toastPlace = key;
    this.panels.root.style.setProperty('--toast-bottom', `${bottom}px`);
    this.panels.root.style.setProperty('--toast-w', `${Math.round(width)}px`);
  }

  // ---------------------------------------------------------------- focus

  /** Selection was opened with focus (list, feed, notice, Center): updates focus when area changes. */
  setIntent(sel: NonNullable<Selection>, follow: boolean | 'option' = 'option'): void {
    this.intent = { sel, follow };
  }

  clearIntent(): void {
    this.intent = null;
  }

  /** Selection changed outside the UI (canvas click, agent left). */
  selectionChangedExternally(prev: Selection, sel: Selection): void {
    if (this.intent && !sameSelection(this.intent.sel, sel)) this.intent = null;
    if (!prev && sel) this.beginGuard();
    else if (!sel) this.endGuard(false);
  }

  /** Selection made by the UI: drawer counts immediately (subsequent focus already uses the right area). */
  selectingFromUi(): void {
    this.endGuard(false);
  }

  private refocus(): void {
    const it = this.intent;
    if (!it || !sameSelection(it.sel, this.world.getSelection())) return;
    if (it.sel.type === 'agent') this.world.focusAgent(it.sel.id, { follow: it.follow === 'option' ? this.world.getOptions().followSelected : it.follow });
    else this.world.focusRoom(it.sel.id);
  }

  // ---------------------------------------------------------------- double-click window

  private beginGuard(): void {
    this.endGuard(false);
    this.panels.drawer.classList.add('is-opening');
    this.guardTimer = setTimeout(() => this.endGuard(true), DBLCLICK_GUARD_MS);
  }

  private endGuard(check: boolean): void {
    if (this.guardTimer === null) return;
    clearTimeout(this.guardTimer);
    this.guardTimer = null;
    this.panels.drawer.classList.remove('is-opening');
    this.sync();
    if (check) this.ensureVisibleSoon();
  }

  /** After camera settles: if selected agent ended up outside free area, move camera to it. */
  private ensureVisibleSoon(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      const sel = this.world.getSelection();
      if (sel?.type !== 'agent' || this.intent) return;
      const p = this.world.screenPositionOf(sel.id);
      const i = this.insets;
      const visible = !!p && p.x >= i.left && p.x <= innerWidth - i.right && p.y >= i.top && p.y <= innerHeight - i.bottom;
      if (!visible) this.world.focusAgent(sel.id, { follow: this.world.getOptions().followSelected });
    }, CAMERA_SETTLE_MS);
  }

  /** Double click/tap on canvas: world already focused target; UI maintains this focus. */
  private onDoubleActivate(): void {
    const sel = this.world.getSelection();
    if (!sel) return;
    // Double click on agent = focus and follow; on room = frame room.
    this.intent = { sel, follow: sel.type === 'agent' };
    if (this.guarding) this.endGuard(false);
  }

  // ---------------------------------------------------------------- camera interaction

  private watchCanvas(): void {
    addEventListener('dblclick', (e) => isCanvas(e.target) && this.onDoubleActivate());
    addEventListener(
      'pointerdown',
      (e) => {
        this.down = isCanvas(e.target) ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
      },
      true,
    );
    addEventListener(
      'pointermove',
      (e) => {
        if (!this.down || e.buttons === 0) return;
        if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > DRAG_PX) {
          // Dragged (or pinched): user took control of camera.
          this.intent = null;
          this.down = null;
          this.lastTap.t = 0;
        }
      },
      true,
    );
    addEventListener(
      'pointerup',
      (e) => {
        const d = this.down;
        this.down = null;
        if (!d || !isCanvas(e.target) || e.pointerType === 'mouse') return;
        // Double tap (browser doesn't fire dblclick for touch with touch-action: none).
        const now = performance.now();
        if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < DOUBLE_TAP_PX) {
          this.lastTap.t = 0;
          // World handles touch in the same event: wait for it to apply selection/focus.
          queueMicrotask(() => this.onDoubleActivate());
        } else {
          this.lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      },
      true,
    );
    addEventListener('wheel', (e) => isCanvas(e.target) && (this.intent = null), { capture: true, passive: true });
    addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
        if (CAMERA_KEYS.has(e.key)) this.intent = null;
      },
      true,
    );
  }

  // ---------------------------------------------------------------- measurement

  /** Layout positions (offset*), which ignore the transform of open/close animations. */
  private measure(): PanelGeometry {
    const { topbar, sidebar, drawer } = this.panels;
    const vw = innerWidth;
    const vh = innerHeight;
    const drawerSheet = drawer.offsetWidth >= vw - 40 && drawer.offsetTop > topbar.offsetHeight + 40;
    return {
      vw,
      vh,
      topBottom: topbar.offsetTop + topbar.offsetHeight,
      sideRight: sidebar.offsetLeft + sidebar.offsetWidth,
      drawerLeft: drawer.offsetLeft,
      drawerTop: drawer.offsetTop,
      drawerSheet,
      feedOpenH: this.probeFeedOpen.offsetHeight,
      feedClosedH: this.probeFeedClosed.offsetHeight,
      feedMargin: this.probeGap.offsetWidth,
    };
  }
}
