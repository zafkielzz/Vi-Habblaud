// "Go to HB-XXXX" and "Visit a random building" (Phase 5): the city's only teleport. Field and button
// sit on the minimap; code is sent as typed (formatted) via ↑ `teleport {code}` and the world server
// replies with `pos` on the doorstep sidewalk (or `notice` not_found). Scene fades to black in between.
// Pure model (tested): typed code and fade phases. DOM part uses `ui-city-tp*` from city/social.css.
import { tr } from '../../../../shared/i18n';
import { h, setHidden, setText } from '../../ui/dom';

/** The 30 code symbols (excluding 0/O, 1/I/L and U, which are easily confused). */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^HB-[2-9A-HJKMNP-TV-Z]{4}$/;

/** Code as typed ("hb-4f2k", "HB 4F2K", "4f2k") in canonical format, or null if invalid. */
export function normalizeBuildingCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s_]+/g, '');
  const body = s.startsWith('HB-') ? s.slice(3) : s.startsWith('HB') && s.length === 6 ? s.slice(2) : s;
  const code = `HB-${body}`;
  return CODE_RE.test(code) ? code : null;
}

/** Duration of each fade phase (ms): fade out, wait for response (maximum), and fade in. */
export const FADE = { out: 320, wait: 5_000, in: 520 } as const;

export type FadePhase = 'idle' | 'out' | 'wait' | 'in';

/**
 * Teleport fade: fades out, waits for `pos` (or gives up at FADE.wait), and fades in. `arrived` comes from `pos`;
 * `failed` from a `notice` (code not found): fades in at the same place.
 */
export class TeleportFade {
  private phase: FadePhase = 'idle';
  private since = 0;
  private landed = false;

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  start(now: number): void {
    this.phase = 'out';
    this.since = now;
    this.landed = false;
  }

  /** Received `pos` (or failed): fades in once fade-out completes. */
  arrived(): void {
    if (this.phase === 'out' || this.phase === 'wait') this.landed = true;
  }

  failed(): void {
    this.arrived();
  }

  /** Current phase and darkness (0..1). Stops waiting after FADE.wait. */
  tick(now: number): { phase: FadePhase; dark: number; timedOut: boolean } {
    let timedOut = false;
    if (this.phase === 'out' && now - this.since >= FADE.out) {
      this.phase = 'wait';
      this.since = now;
    }
    if (this.phase === 'wait' && (this.landed || now - this.since >= FADE.wait)) {
      timedOut = !this.landed;
      this.phase = 'in';
      this.since = now;
    }
    if (this.phase === 'in' && now - this.since >= FADE.in) this.phase = 'idle';
    const t = now - this.since;
    const dark = this.phase === 'out' ? Math.min(1, t / FADE.out) : this.phase === 'wait' ? 1 : this.phase === 'in' ? Math.max(0, 1 - t / FADE.in) : 0;
    return { phase: this.phase, dark, timedOut };
  }
}

// ====================================================================== DOM

export interface TeleportActions {
  /** "Go to" with a code already in canonical format. */
  go(code: string): void;
  /** "Visit a random building". */
  random(): void;
}

/** The "Go to HB-XXXX" input and "Visit a random building" button, above the minimap. */
export class TeleportPanel {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly goBtn: HTMLButtonElement;
  private readonly diceBtn: HTMLButtonElement;

  constructor(private readonly actions: TeleportActions) {
    this.input = h('input', {
      class: 'ui-city-tp__input',
      type: 'text',
      attrs: { placeholder: 'HB-XXXX', maxlength: 9, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': tr('Building code') },
    });
    this.goBtn = h('button', { class: 'ui-city-tp__go', type: 'submit', text: tr('Go'), title: tr("Go to this building's door") });
    this.diceBtn = h(
      'button',
      { class: 'ui-city-tp__dice', type: 'button', title: tr('Visit a random building'), attrs: { 'aria-label': tr('Visit a random building') }, on: { click: () => this.actions.random() } },
      h('span', { text: '🎲', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-city-tp__dice-text', text: tr('Random') }),
    );
    this.error = h('p', { class: 'ui-city-tp__error', role: 'alert', hidden: true });
    const form = h(
      'form',
      { class: 'ui-city-tp__form', attrs: { 'aria-label': tr('Go to a building by its code') } },
      h('span', { class: 'ui-city-tp__label', text: tr('Go to'), attrs: { 'aria-hidden': 'true' } }),
      this.input,
      this.goBtn,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('input', () => setHidden(this.error, true));
    this.input.addEventListener('keydown', (e) => {
      // city hotkeys are disabled when field is focused; Esc unfocuses
      e.stopPropagation();
      if (e.key === 'Escape') this.input.blur();
    });
    this.el = h('div', { class: 'ui-city-tp' }, form, this.diceBtn, this.error);
  }

  /** Error below input (malformed code, or no building matches). */
  showError(text: string): void {
    setText(this.error, text);
    setHidden(this.error, false);
  }

  setBusy(on: boolean): void {
    this.goBtn.disabled = on;
    this.diceBtn.disabled = on;
  }

  clear(): void {
    this.input.value = '';
    setHidden(this.error, true);
  }

  private submit(): void {
    const code = normalizeBuildingCode(this.input.value);
    if (!code) {
      this.showError(tr('The code looks like HB-XXXX (letters and numbers, no 0, O, 1, I, L or U).'));
      return;
    }
    this.input.value = code;
    this.input.blur();
    this.actions.go(code);
  }
}
