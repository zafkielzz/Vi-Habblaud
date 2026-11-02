import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESSORIES, BOTTOM_STYLES, FACIAL_HAIR, HAIR_STYLES, PART_KEYS, TOP_STYLES } from '../../../shared/appearance';
import { appearanceFromSeed } from '../art/character/appearance';
import { canEditCharacter, changedParts, EDITOR_GROUPS, rowVisible, styleLabel } from './character-model';
import { CharacterEditor } from './character-editor';
import type { UiContext } from './context';

const OPEN = { live: true, terminal: true, local: true, replaying: false, mock: false };
const MAIN = { id: '.claude:1', kind: 'main', status: 'working' } as const;

describe('canEditCharacter', () => {
  it('only the real live main agent with local access (not in timelapse or mock)', () => {
    expect(canEditCharacter(MAIN, OPEN)).toBe(true);
    expect(canEditCharacter({ ...MAIN, id: 's:sub', kind: 'sub' }, OPEN)).toBe(false);
    expect(canEditCharacter({ ...MAIN, id: 'demo:x-1' }, OPEN)).toBe(false);
    for (const k of ['live', 'terminal', 'local'] as const) expect(canEditCharacter(MAIN, { ...OPEN, [k]: false })).toBe(false);
    for (const k of ['replaying', 'mock'] as const) expect(canEditCharacter(MAIN, { ...OPEN, [k]: true })).toBe(false);
  });

  it('leaving agents (offline, during the 20 s grace period) do not get the edit pencil; other statuses do', () => {
    expect(canEditCharacter({ ...MAIN, status: 'offline' }, OPEN)).toBe(false);
    for (const status of ['idle', 'waiting', 'shell'] as const) expect(canEditCharacter({ ...MAIN, status }, OPEN), status).toBe(true);
  });
});

describe('changedParts', () => {
  it('only parts differing from seed appearance, in fixed order', () => {
    const base = appearanceFromSeed(3, { look: 'm' });
    const skin = base.skin === '#5a3623' ? '#ffe2cc' : '#5a3623';
    const topStyle = base.topStyle === 'jacket' ? 'polo' : 'jacket';
    const parts = changedParts(base, { ...base, topStyle, skin });
    expect(parts).toEqual({ skin, topStyle });
    expect(Object.keys(parts)).toEqual(['skin', 'topStyle']);
    expect(changedParts(base, { ...base })).toEqual({});
  });

  it('order comes from PART_KEYS, not the edited appearance key order', () => {
    const base = appearanceFromSeed(3, { look: 'm' });
    const shoes = base.shoes === '#101010' ? '#ffffff' : '#101010';
    const bottomStyle = base.bottomStyle === 'skirt' ? 'pants' : 'skirt';
    // In appearance literal shoes comes before bottomStyle; in PART_KEYS it is the opposite.
    expect(Object.keys(base).indexOf('shoes')).toBeLessThan(Object.keys(base).indexOf('bottomStyle'));
    expect(PART_KEYS.indexOf('bottomStyle')).toBeLessThan(PART_KEYS.indexOf('shoes'));
    expect(Object.keys(changedParts(base, { ...base, shoes, bottomStyle }))).toEqual(['bottomStyle', 'shoes']);

    // Even with edited keys in reverse order, result follows PART_KEYS order.
    const skin = base.skin === '#5a3623' ? '#ffe2cc' : '#5a3623';
    const topStyle = base.topStyle === 'jacket' ? 'polo' : 'jacket';
    const reversed = Object.fromEntries(Object.entries({ ...base, shoes, bottomStyle, topStyle, skin }).reverse()) as unknown as typeof base;
    expect(Object.keys(reversed).indexOf('shoes')).toBeLessThan(Object.keys(reversed).indexOf('skin'));
    expect(Object.keys(changedParts(base, reversed))).toEqual(['skin', 'topStyle', 'bottomStyle', 'shoes']);
  });
});

describe('editor groups and labels', () => {
  it('all parts appear once in the editor', () => {
    const keys = EDITOR_GROUPS.flatMap((g) => g.rows.map((r) => r.key));
    expect([...keys].sort()).toEqual([...PART_KEYS].sort());
  });

  it('every style has a label', () => {
    const lists = { hairStyle: HAIR_STYLES, topStyle: TOP_STYLES, bottomStyle: BOTTOM_STYLES, accessory: ACCESSORIES, facialHair: FACIAL_HAIR } as const;
    for (const [key, values] of Object.entries(lists)) {
      for (const v of values) expect(styleLabel(key as keyof typeof lists, v), `${key}=${v}`).not.toBe(v);
    }
  });

  it('accessory color disappears when there is no accessory', () => {
    const color = EDITOR_GROUPS.flatMap((g) => g.rows).find((r) => r.key === 'accessoryColor')!;
    expect(rowVisible(color, { accessory: 'none' })).toBe(false);
    expect(rowVisible(color, { accessory: 'cap' })).toBe(true);
  });
});

// Minimal elements to exercise the editor in Node environment, without canvas rendering.
class EditorElement {
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  value = '';
  private attrs = new Map<string, string>();
  private clicks: (() => void)[] = [];

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  addEventListener(name: string, listener: () => void): void { if (name === 'click') this.clicks.push(listener); }
  append(): void {}
  replaceChildren(): void {}
  getContext(): null { return null; }
  focus(): void { (document as unknown as { activeElement: EditorElement }).activeElement = this; }
  select(): void {}
  click(): void { if (!this.disabled) for (const listener of this.clicks) listener(); }
}

function characterEditor() {
  const elements: EditorElement[] = [];
  vi.stubGlobal('document', {
    activeElement: null,
    createElement: () => {
      const el = new EditorElement();
      elements.push(el);
      return el;
    },
  });
  let resolve!: (error: string | undefined) => void;
  const response = new Promise<string | undefined>((done) => { resolve = done; });
  const announce = vi.fn();
  const editor = new CharacterEditor({
    agent: (id: string) => ({ id, roomId: id, seed: 3, look: 'm', name: id, custom: true }),
    store: { saveCharacter: () => response, resetCharacter: () => response },
    announce,
  } as unknown as UiContext);
  const button = editor.button as unknown as EditorElement;
  const input = elements.find((el) => el.className === 'ui-char__name')!;
  const error = elements.find((el) => el.className === 'ui-char__error')!;
  const save = elements.find((el) => el.textContent === 'Save')!;
  const reset = elements.find((el) => el.className === 'ui-link-btn ui-char__reset')!;
  const open = (id: string) => { editor.open(id); button.click(); };
  const send = (operation: 'save' | 'reset') => {
    if (operation === 'save') save.click();
    else { reset.click(); reset.click(); }
  };
  const settle = async (error?: string) => { resolve(error); await response; };
  return { editor, button, input, error, save, open, send, settle, announce };
}

describe('async responses of character editor', () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const operation of ['save', 'reset'] as const) {
    for (const next of ['b', 'a']) {
      it.each([undefined, 'No connection to Habblaud.'])(`${operation}: response %s does not alter new editing of ${next}`, async (error) => {
        const ui = characterEditor();
        ui.open('a');
        ui.send(operation);
        if (next === 'a') ui.editor.close();
        ui.open(next);
        ui.input.value = 'New draft';
        const focused = document.activeElement;

        await ui.settle(error);

        expect(ui.editor.el.hidden).toBe(false);
        expect(ui.button.getAttribute('aria-expanded')).toBe('true');
        expect(ui.input.value).toBe('New draft');
        expect(ui.error.hidden).toBe(true);
        expect(ui.error.textContent).toBe('');
        expect(document.activeElement).toBe(focused);
        expect(ui.announce).not.toHaveBeenCalled();
      });
    }

    it(`${operation}: success on current edit closes editor and announces result`, async () => {
      const ui = characterEditor();
      ui.open('a');
      ui.send(operation);

      await ui.settle();

      expect(ui.editor.el.hidden).toBe(true);
      expect(ui.button.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(ui.button);
      expect(ui.announce).toHaveBeenCalledWith(operation === 'save' ? 'Character saved: a.' : 'The character is back to random.');
    });
  }
});
