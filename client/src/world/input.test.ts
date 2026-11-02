import { afterEach, describe, expect, it } from 'vitest';
import type { Camera } from './camera';
import { attachInput, type InputHandlers } from './input';

/** Minimal `window`: camera keyboard listener registers on `keydown`. */
function installWindow(): { dispatch(ev: { key: string; target: unknown }): void; restore(): void } {
  const prev = globalThis.window;
  const listeners = new Set<(ev: KeyboardEvent) => void>();
  globalThis.window = {
    addEventListener(_type: string, fn: (ev: KeyboardEvent) => void) {
      listeners.add(fn);
    },
    removeEventListener(_type: string, fn: (ev: KeyboardEvent) => void) {
      listeners.delete(fn);
    },
  } as unknown as Window & typeof globalThis;
  return {
    dispatch(partial) {
      const ev = {
        defaultPrevented: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...partial,
      };
      for (const fn of listeners) fn(ev as unknown as KeyboardEvent);
    },
    restore() {
      globalThis.window = prev;
    },
  };
}

function canvas(): HTMLCanvasElement {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    setPointerCapture() {},
  } as unknown as HTMLCanvasElement;
}

function handlers(): InputHandlers {
  return { pick: () => null, click() {}, doubleClick() {}, hover() {}, interact() {}, overview() {}, zoomStep() {} };
}

describe('camera keyboard controls', () => {
  let win: ReturnType<typeof installWindow>;
  let off: (() => void) | null = null;

  afterEach(() => {
    off?.();
    off = null;
    win?.restore();
  });

  it('ArrowRight when radio is focused does not move camera', () => {
    win = installWindow();
    const pans: [number, number][] = [];
    const camera = { zoom: 1, panBy: (dx: number, dy: number) => pans.push([dx, dy]), zoomAt() {}, settle() {} } as unknown as Camera;
    off = attachInput(canvas(), camera, handlers());
    win.dispatch({
      key: 'ArrowRight',
      target: {
        tagName: 'BUTTON',
        isContentEditable: false,
        getAttribute: (name: string) => (name === 'role' ? 'radio' : null),
      },
    });
    // The bug: speed group arrow arrived here as panBy(-90, 0).
    expect(pans).toEqual([]);
  });

  it('ArrowRight when standard button is focused still moves camera', () => {
    win = installWindow();
    const pans: [number, number][] = [];
    const camera = { zoom: 1, panBy: (dx: number, dy: number) => pans.push([dx, dy]), zoomAt() {}, settle() {} } as unknown as Camera;
    off = attachInput(canvas(), camera, handlers());
    // After clicking a toolbar button, it retains focus: arrow keys still control camera.
    win.dispatch({ key: 'ArrowRight', target: { tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null } });
    expect(pans).toEqual([[-90, 0]]);
  });

  it('ArrowRight when world is focused still moves camera', () => {
    win = installWindow();
    const pans: [number, number][] = [];
    const camera = { zoom: 1, panBy: (dx: number, dy: number) => pans.push([dx, dy]), zoomAt() {}, settle() {} } as unknown as Camera;
    off = attachInput(canvas(), camera, handlers());
    win.dispatch({
      key: 'ArrowRight',
      target: { tagName: 'BODY', isContentEditable: false },
    });
    expect(pans).toEqual([[-90, 0]]);
  });
});

describe('modalOpen', () => {
  /** Minimal `document`: select elements and `querySelector` for selectors used by function. */
  function installDocument(els: { tag: string; open?: boolean; ariaModal?: boolean }[]): () => void {
    const prev = globalThis.document;
    const matches = (sel: string, e: (typeof els)[number]): boolean => {
      if (sel === 'dialog[open]') return e.tag === 'dialog' && !!e.open;
      if (sel === ':not(dialog)[aria-modal="true"]') return e.tag !== 'dialog' && !!e.ariaModal;
      if (sel === '[aria-modal="true"]') return !!e.ariaModal;
      if (sel === ':popover-open') return false;
      throw new Error(`unexpected selector in test: ${sel}`);
    };
    globalThis.document = {
      querySelector: (sel: string) => els.find((e) => sel.split(', ').some((s) => matches(s, e))) ?? null,
    } as unknown as Document;
    return () => {
      globalThis.document = prev;
    };
  }

  it('a closed <dialog> (even with aria-modal) does not block city keyboard', async () => {
    const { modalOpen } = await import('./input');
    const restore = installDocument([{ tag: 'dialog', open: false, ariaModal: true }]);
    try {
      expect(modalOpen(null)).toBe(false);
    } finally {
      restore();
    }
  });

  it('an open <dialog>, or another element with aria-modal, blocks input', async () => {
    const { modalOpen } = await import('./input');
    for (const els of [[{ tag: 'dialog', open: true }], [{ tag: 'div', ariaModal: true }]]) {
      const restore = installDocument(els);
      try {
        expect(modalOpen(null)).toBe(true);
      } finally {
        restore();
      }
    }
  });
});
