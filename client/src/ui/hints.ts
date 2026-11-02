// Hold Alt: a game-style overlay that dims the screen and pins a short note on every button and area you can see,
// saying what it is for; releasing Alt hides it. A note comes from `data-hint` (set where a button's own text does not
// say enough: "Take over here", "End", the usage cards, the drawer sections…), else from the button's tooltip.
// Only what is really on screen gets a note: hidden, scrolled away or covered elements (checked with
// elementFromPoint) are skipped, and notes that would overlap are dropped. Without a keyboard (mobile), Help has a
// button that shows the overlay until the next tap.
import { h } from './dom';

/** Alt held this long before the overlay shows (a quick Alt+Tab never flashes it). */
const HOLD_MS = 180;
/** Area (px²) from which an element is a region (sidebar, feed, office): its note goes inside it. */
const REGION_AREA = 60_000;
const MAX_TEXT = 140;
const GAP = 4;

interface Target {
  el: HTMLElement;
  text: string;
  rect: DOMRect;
  region: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Buttons whose tooltip is good enough as a note: toolbar icons, text buttons and counters. List rows, feed entries and
 * account chips also have tooltips, but they only repeat what they show: no note (the office would drown in them).
 */
const TOOL_BUTTONS = '.ui-icon-btn, .ui-btn, .ui-counter';

/** The note of an element: `data-hint`, else the tooltip or accessible name of a tool button. */
export function hintText(el: HTMLElement): string {
  const own = el.dataset.hint?.trim();
  if (own) return own;
  if (el.tagName !== 'BUTTON' || !el.matches(TOOL_BUTTONS)) return '';
  const text = (el.title || el.getAttribute('aria-label') || '').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Overlap of two boxes, with a small gap so notes do not touch. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/**
 * Where a note of size w×h goes for a target: inside a region (middle, else top); below, above, right or left of a
 * button.
 * Clamped to the viewport; the first spot free of the notes already placed (and, for a button, of the button itself)
 * wins; none = the note is dropped.
 */
export function placeNote(t: { rect: Box; region: boolean }, w: number, h: number, placed: readonly Box[], view: { w: number; h: number }): Box | null {
  const r = t.rect;
  const cx = r.x + r.w / 2 - w / 2;
  const spots: Array<[number, number]> = t.region
    ? [
        [cx, r.y + r.h / 2 - h / 2],
        [cx, r.y + 8],
      ]
    : [
        [cx, r.y + r.h + 6],
        [cx, r.y - h - 6],
        [r.x + r.w + 6, r.y + r.h / 2 - h / 2],
        [r.x - w - 6, r.y + r.h / 2 - h / 2],
      ];
  for (const [x0, y0] of spots) {
    const box = { x: Math.max(4, Math.min(view.w - w - 4, x0)), y: Math.max(4, Math.min(view.h - h - 4, y0)), w, h };
    // nor over its own button (a spot clamped at the screen edge could land on it)
    if (!placed.some((p) => overlaps(p, box)) && (t.region || !overlaps(r, box))) return box;
  }
  return null;
}

/** Is the element on screen and not covered (its center, or failing that a corner, hits it or a child)? */
function visible(el: HTMLElement, r: DOMRect): boolean {
  if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
  const probes: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + 3, r.top + 3],
    [r.right - 3, r.bottom - 3],
  ];
  return probes.some(([x, y]) => {
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, x)), Math.min(innerHeight - 1, Math.max(0, y)));
    return !!hit && (hit === el || el.contains(hit));
  });
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

export class HintOverlay {
  readonly el: HTMLElement;
  private shown = false;
  private sticky = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `root`: where to look for buttons and areas (the whole page, so the office canvas counts too). */
  constructor(private root: HTMLElement) {
    this.el = h('div', { class: 'ui-hints', attrs: { 'aria-hidden': 'true' }, hidden: true });
    addEventListener('keydown', (e) => this.onKeyDown(e), true);
    addEventListener('keyup', (e) => this.onKeyUp(e), true);
    addEventListener('blur', () => this.hide());
    addEventListener('resize', () => this.hide());
    document.addEventListener('visibilitychange', () => this.hide());
    // Sticky mode (from Help, without a keyboard): the next tap or click anywhere hides it.
    addEventListener(
      'pointerdown',
      () => {
        if (this.sticky) this.hide();
      },
      true,
    );
  }

  /** Shows the notes for what is on screen now; `sticky` keeps them until the next tap or key. */
  show(sticky = false): void {
    this.sticky = sticky;
    this.render();
    this.shown = true;
    this.el.hidden = false;
    // Top layer (popover), so the notes also cover an open dialog (the Board, Help…).
    try {
      if (!this.el.hasAttribute('popover')) this.el.setAttribute('popover', 'manual');
      if (!this.el.matches(':popover-open')) this.el.showPopover();
    } catch {
      // browser without popover: z-index only
    }
  }

  hide(): void {
    this.cancel();
    if (!this.shown) return;
    this.shown = false;
    this.sticky = false;
    try {
      if (this.el.matches(':popover-open')) this.el.hidePopover();
    } catch {
      // browser without popover
    }
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  get isShown(): boolean {
    return this.shown;
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Alt in a text box or the terminal belongs to them (word jumps, readline).
      if (isTyping(e.target) || (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      this.cancel();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.show();
      }, HOLD_MS);
      return;
    }
    // Any other key (Alt+Tab, Alt+F4, Alt+letter, or a key in sticky mode) puts it away.
    if (this.timer || this.shown) this.hide();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key !== 'Alt') return;
    // Releasing Alt after the overlay would open the browser menu bar (Firefox, Windows): not this time.
    if (this.shown && !this.sticky) e.preventDefault();
    if (!this.sticky) this.hide();
  }

  private targets(): Target[] {
    const out: Target[] = [];
    const seen = new Set<HTMLElement>();
    const texts = new Set<string>();
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-hint], button[title], button[aria-label]')) {
      if (seen.has(el) || this.el.contains(el)) continue;
      seen.add(el);
      const text = hintText(el);
      // the same note once (three usage cards say the same thing)
      if (!text || texts.has(text)) continue;
      const rect = el.getBoundingClientRect();
      if (!visible(el, rect)) continue;
      texts.add(text);
      out.push({ el, text, rect, region: rect.width * rect.height >= REGION_AREA });
    }
    // Explicit notes first (they explain the confusing ones), then small before large, left to right.
    return out.sort((a, b) => Number(!b.el.dataset.hint) - Number(!a.el.dataset.hint) || Number(a.region) - Number(b.region) || a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }

  private render(): void {
    const targets = this.targets();
    const outlines = targets.map((t) => {
      const box = h('div', { class: `ui-hints__box${t.region ? ' is-region' : ''}` });
      Object.assign(box.style, { left: `${t.rect.left}px`, top: `${t.rect.top}px`, width: `${t.rect.width}px`, height: `${t.rect.height}px` });
      return box;
    });
    const notes = targets.map((t) => h('div', { class: 'ui-hints__note', text: t.text }));
    this.el.replaceChildren(...outlines, ...notes);
    this.el.hidden = false;
    // Measure every note once (one layout), then place them.
    const sizes = notes.map((n) => ({ w: n.offsetWidth, h: n.offsetHeight }));
    const placed: Box[] = [];
    const view = { w: innerWidth, h: innerHeight };
    targets.forEach((t, i) => {
      const r = t.rect;
      const box = placeNote({ rect: { x: r.left, y: r.top, w: r.width, h: r.height }, region: t.region }, sizes[i].w, sizes[i].h, placed, view);
      if (!box) {
        notes[i].remove();
        outlines[i].remove();
        return;
      }
      placed.push(box);
      Object.assign(notes[i].style, { left: `${box.x}px`, top: `${box.y}px` });
    });
  }
}
