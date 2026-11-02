// Character parts (skin, hair and style, eyes, top, pants, shoes, accessory, beard) with full-body preview:
// the core of the character editor, used in agent drawer (character-editor.ts) and Habblaud World
// character (world/settings-world.ts). Caller manages name, saving, and sending; here only appearance is chosen.
import type { PartKey } from '../../../shared/appearance';
import { characterSprite, editorConflict, editorOptions, fitToOptions } from '../art';
import type { Appearance } from '../art/api';
import { EDITOR_GROUPS, rowVisible, styleLabel, type EditorRow } from './character-model';
import { h } from './dom';
import { tr } from '../../../shared/i18n';

/** Screen pixels per character pixel in preview. */
const PREVIEW_SCALE = 4;

export class AppearanceFields {
  /** Full-body preview (canvas). */
  readonly preview: HTMLCanvasElement;
  /** Part groups (skin, hair...), redrawn on each selection. */
  readonly groups: HTMLElement;
  private draft: Appearance | null = null;

  constructor(private readonly onChange: (a: Appearance) => void = () => {}) {
    this.preview = h('canvas', { class: 'ui-char__preview', role: 'img', attrs: { 'aria-label': tr('Character preview') } });
    this.groups = h('div', { class: 'ui-char__groups' });
  }

  /** Appearance being edited (null before first `set`). */
  get value(): Appearance | null {
    return this.draft;
  }

  /** Replaces entire appearance (initial edit, "Randomize") and redraws. */
  set(a: Appearance): void {
    this.draft = a;
    this.paint();
  }

  private pick(key: PartKey, value: string): void {
    if (!this.draft) return;
    this.draft = fitToOptions({ ...this.draft, [key]: value });
    this.paint(key);
    this.onChange(this.draft);
  }

  /** Redraws preview and options; `focusKey` returns focus to checked option of that row. */
  paint(focusKey?: PartKey): void {
    const a = this.draft;
    if (!a) return;
    this.drawPreview(a);
    const options = editorOptions(a);
    this.groups.replaceChildren(
      ...EDITOR_GROUPS.map((g) =>
        h(
          'fieldset',
          { class: 'ui-char__group' },
          h('legend', { text: g.title }),
          ...g.rows.filter((r) => rowVisible(r, a)).map((r) => this.row(g.title, r, a, options[r.key])),
        ),
      ),
    );
    if (focusKey) this.groups.querySelector<HTMLElement>(`[data-key="${focusKey}"] [aria-checked="true"]`)?.focus();
  }

  private row(group: string, r: EditorRow, a: Appearance, values: readonly string[]): HTMLElement {
    const current = a[r.key] ?? '';
    const isColor = r.kind === 'color';
    const buttons = values.map((v) => {
      const conflict = editorConflict(a, r.key, v);
      const label = isColor ? v : styleLabel(r.key, v);
      return h('button', {
        class: isColor ? 'ui-char__swatch' : 'ui-char__chip',
        type: 'button',
        role: 'radio',
        tabIndex: v === current ? 0 : -1,
        title: conflict ?? label,
        style: isColor ? `--swatch: ${v}` : undefined,
        text: isColor ? undefined : label,
        attrs: { 'aria-checked': String(v === current), 'aria-disabled': conflict ? 'true' : undefined, 'aria-label': isColor ? v : undefined },
        on: { click: () => (conflict ? undefined : this.pick(r.key, v)) },
      });
    });
    if (buttons.length && !buttons.some((b) => b.tabIndex === 0)) buttons[0].tabIndex = 0;
    const list = h(
      'div',
      { class: `ui-char__opts ui-char__opts--${r.kind}`, role: 'radiogroup', attrs: { 'aria-label': `${group}: ${r.label}`, 'data-key': r.key } },
      ...buttons,
    );
    list.addEventListener('keydown', (ev) => this.onRadioKey(ev, buttons, r.key, values));
    return h('div', { class: 'ui-char__row' }, h('span', { class: 'ui-char__row-label', text: r.label }), list);
  }

  /** Arrow keys change selection within row (radiogroup pattern), skipping disabled options. */
  private onRadioKey(ev: KeyboardEvent, buttons: HTMLButtonElement[], key: PartKey, values: readonly string[]): void {
    const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const n = buttons.length;
    const from = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    for (let i = 1; i < n; i++) {
      const j = (((from + step * i) % n) + n) % n;
      if (buttons[j].getAttribute('aria-disabled') !== 'true') return this.pick(key, values[j]);
    }
  }

  private drawPreview(a: Appearance): void {
    try {
      const s = characterSprite({ appearance: a, dir: 'down', pose: 'stand', frame: 0 });
      const c = this.preview;
      c.width = s.canvas.width * PREVIEW_SCALE;
      c.height = s.canvas.height * PREVIEW_SCALE;
      const g = c.getContext('2d');
      if (!g) return;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(s.canvas, 0, 0, c.width, c.height);
    } catch (err) {
      // Art may still be under construction: editor remains usable without preview.
      console.warn('[ui] failed to draw character preview', err);
    }
  }
}
