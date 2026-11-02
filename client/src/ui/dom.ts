// UI DOM utilities: element creation, minimal updates, and keyed lists.

type Child = Node | string | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  title?: string;
  style?: string;
  role?: string;
  tabIndex?: number;
  hidden?: boolean;
  type?: string;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
  /** Arbitrary attributes (aria-*, data-*, ...). */
  attrs?: Record<string, string | number | boolean | undefined>;
};

/** Creates an element with properties and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.style) el.setAttribute('style', props.style);
  if (props.role) el.setAttribute('role', props.role);
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
  if (props.hidden) el.hidden = true;
  if (props.type) el.setAttribute('type', props.type);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Button with an icon and accessible label. */
export function iconButton(icon: string, label: string, onClick: (ev: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  const b = h('button', { class: `ui-icon-btn ${extraClass}`.trim(), type: 'button', title: label, attrs: { 'aria-label': label }, on: { click: onClick } });
  b.innerHTML = icon;
  return b;
}

/** Updates text only when changed (avoids unnecessary relayout). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | null | undefined): void {
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

export function setTitle(el: HTMLElement, title: string): void {
  if (el.title !== title) el.title = title;
}

export function setStyleVar(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** Updates the class of a "group" (e.g. status-*), replacing the previous one with the new one. */
export function setVariant(el: HTMLElement, prefix: string, value: string): void {
  const key = `__variant_${prefix}`;
  const rec = el as unknown as Record<string, string | undefined>;
  const prev = rec[key];
  if (prev === value) return;
  if (prev) el.classList.remove(`${prefix}${prev}`);
  el.classList.add(`${prefix}${value}`);
  rec[key] = value;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Animates removal (fade + height collapse) and removes the element. */
export function animateOut(el: HTMLElement, done: () => void, ms = 260): void {
  if (prefersReducedMotion() || typeof el.animate !== 'function' || !el.isConnected) {
    done();
    return;
  }
  const height = el.offsetHeight;
  el.style.overflow = 'hidden';
  el.style.pointerEvents = 'none';
  const anim = el.animate(
    [
      { opacity: 1, height: `${height}px`, transform: 'translateX(0)' },
      { opacity: 0, height: `${height}px`, transform: 'translateX(-10px)', offset: 0.55 },
      { opacity: 0, height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', transform: 'translateX(-10px)' },
    ],
    { duration: ms, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
  );
  anim.onfinish = done;
  anim.oncancel = done;
}

/** Marks a newly created element for entrance animation (class removed when finished). */
export function markEntering(el: HTMLElement): void {
  if (prefersReducedMotion()) return;
  el.classList.add('is-entering');
  el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true });
}

export interface KeyedListOptions<T, E extends HTMLElement> {
  key(item: T): string;
  create(item: T): E;
  update(el: E, item: T): void;
  /** Animates enter/exit transitions (default: true). */
  animate?: boolean;
}

/**
 * Keyed reconciled list: creates, updates, reorders, and removes (with animation) only what changed.
 * Leaving elements stay in place until the animation finishes.
 */
export class KeyedList<T, E extends HTMLElement = HTMLElement> {
  private nodes = new Map<string, E>();
  private leaving = new Map<string, E>();
  private initialized = false;

  constructor(
    readonly container: HTMLElement,
    private opts: KeyedListOptions<T, E>,
  ) {}

  get size(): number {
    return this.nodes.size;
  }

  get(key: string): E | undefined {
    return this.nodes.get(key);
  }

  keys(): IterableIterator<string> {
    return this.nodes.keys();
  }

  sync(items: readonly T[]): void {
    const animate = this.opts.animate !== false && this.initialized;
    const seen = new Set<string>();
    const next = new Set(items.map((item) => this.opts.key(item)));
    let cursor: ChildNode | null = this.container.firstChild;
    // Skip nodes that are leaving or will leave: they stay in place and don't "push" others.
    const skipStale = () => {
      while (cursor && (this.isLeaving(cursor) || !next.has((cursor as HTMLElement).dataset?.key ?? ''))) cursor = cursor.nextSibling;
    };
    for (const item of items) {
      const k = this.opts.key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      let el = this.nodes.get(k);
      if (!el) {
        const old = this.leaving.get(k);
        if (old) {
          // Returned before finishing exit animation: discard old and recreate.
          old.getAnimations?.().forEach((a) => a.cancel());
          old.remove();
          this.leaving.delete(k);
        }
        el = this.opts.create(item);
        el.dataset.key = k;
        this.nodes.set(k, el);
        if (animate) markEntering(el);
      }
      this.opts.update(el, item);
      skipStale();
      if (cursor === el) cursor = el.nextSibling;
      else this.container.insertBefore(el, cursor);
    }
    for (const [k, el] of this.nodes) {
      if (seen.has(k)) continue;
      this.nodes.delete(k);
      if (!animate) {
        el.remove();
        continue;
      }
      this.leaving.set(k, el);
      el.classList.add('is-leaving');
      animateOut(el, () => {
        if (this.leaving.get(k) === el) this.leaving.delete(k);
        el.remove();
      });
    }
    this.initialized = true;
  }

  clear(): void {
    for (const el of this.nodes.values()) el.remove();
    for (const el of this.leaving.values()) el.remove();
    this.nodes.clear();
    this.leaving.clear();
    // The next populate is "from scratch": no item-by-item entrance animation.
    this.initialized = false;
  }

  private isLeaving(node: ChildNode): boolean {
    return node instanceof HTMLElement && node.classList.contains('is-leaving');
  }
}

/** Copies text to clipboard, with fallback for contexts without Clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
    ta.value = text;
    // With a modal open, the rest of the page is inert (and the field wouldn't be selected): append into it.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (active?.closest('dialog[open]') ?? document.body).append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    active?.focus();
    return ok;
  }
}
