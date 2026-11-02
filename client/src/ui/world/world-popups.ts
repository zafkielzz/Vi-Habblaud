// Habblaud World launch popups, a true modal (<dialog> on top layer with darkened backdrop, focus trapped,
// and Esc closing) over the office, and on top of Habblaud World dialog when open:
// - "New: Habblaud World", for users without an account. "Not now" closes and it returns after 3 days, up to
//   3 times max; "Don't show again" dismisses permanently; once account is created, never again. With Settings or
//   World dialog open, it waits.
// - "You're on the waitlist", immediately after signup (or upon opening page while waiting), once per browser.
// - "Access granted!", when account is approved with page open (or on open if approved without character), once per
//   browser; "Create character" opens Habblaud World dialog on character screen.
// Decided by nextWorldPopup (world-model.ts, pure and tested); memory is saved to localStorage when popup appears
// (without storage, applies only to this page). Only with configured World server and page opened on computer itself:
// never via mobile port, timelapse, or demo mode.
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h } from '../dom';
import { pixelIcon } from '../icons';
import { safeLocalStorage } from '../prefs';
import { extLink, WORLD_PRIVACY_URL } from './links';
import { worldGate } from './settings-world';
import {
  APPROVED_SEEN_KEY,
  EMPTY_POPUP_MEMORY,
  INVITE_SEEN_KEY,
  LAUNCH_KEY,
  nextWorldPopup,
  parsePopupMemory,
  serializePopupMemory,
  WAITLIST_SEEN_KEY,
  type WorldPopupKind,
  type WorldPopupMemory,
} from './world-model';

/** Pixel building (the world is a city of buildings): badge for popups and World dialog header. */
export const WORLD_BUILDING_ICON = pixelIcon(
  [
    '....####....',
    '....#..#....',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.####..####.',
    '.####..####.',
    '############',
  ],
  { '#': 'currentColor' },
  'ui-px-icon ui-world-popup__icon',
);

export interface WorldPopupHooks {
  /** Opens Habblaud World dialog on requested screen (register or character). */
  openWorld(screen: 'register' | 'character'): void;
  /** Settings or World dialog open: launch popup waits (the other two stack on top). */
  panelOpen(): boolean;
}

const TITLE_ID = 'ui-world-popup-title';

export class WorldPopups implements UiComponent {
  readonly el: HTMLDialogElement;
  private memory: WorldPopupMemory;
  private open: WorldPopupKind | null = null;
  /** Element with focus before popup (returns focus there on close). */
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly hooks: WorldPopupHooks,
  ) {
    this.memory = this.load();
    // `aria-modal` only while open: closed, <dialog> remains in DOM and must not look like an open modal
    // (city keyboard and office shortcuts halt in presence of a modal).
    this.el = h('dialog', { class: 'ui-world-popup', attrs: { 'aria-labelledby': TITLE_ID } });
    // Backdrop click (outside content) closes, like "Not now" / "Later".
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('close', () => this.onClosed());
    // Esc closes (modal <dialog> does this already; without showModal, handled here) and doesn't
    // reach office shortcuts.
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (typeof this.el.showModal !== 'function') {
        e.preventDefault();
        this.close();
      }
    });
  }

  render(): void {
    const meta = this.src.meta();
    if (this.open) {
      // Account created through another path (World dialog, another tab): launch popup is no longer valid.
      if (this.open === 'launch' && meta?.state !== 'logged_out') this.close();
      return;
    }
    const gate = { ...worldGate(this.ctx, this.src), replaying: this.ctx.store.replaying };
    const d = nextWorldPopup(meta, gate, this.memory, Date.now());
    // With Settings or World dialog open, launch popup waits for next check (without counting as an impression).
    if (d.show === 'launch' && this.hooks.panelOpen()) return;
    if (d.memory) this.remember(d.memory);
    if (d.show) this.show(d.show);
  }

  // ---------------------------------------------------------------- content

  private show(kind: WorldPopupKind): void {
    this.open = kind;
    const badge = h('span', { class: 'ui-world-popup__badge', attrs: { 'aria-hidden': 'true' } });
    badge.innerHTML = WORLD_BUILDING_ICON;
    const { title, body, actions, primary } = this.content(kind);
    this.el.className = `ui-world-popup is-${kind}`;
    this.el.replaceChildren(
      h('div', { class: 'ui-world-popup__head' }, badge, h('h2', { class: 'ui-world-popup__title', text: title, attrs: { id: TITLE_ID } })),
      h('div', { class: 'ui-world-popup__body' }, ...body),
      h('div', { class: 'ui-world-popup__actions' }, ...actions),
    );
    this.opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof this.el.showModal === 'function') {
      if (!this.el.open) this.el.showModal();
    } else {
      this.el.setAttribute('open', '');
    }
    this.el.setAttribute('aria-modal', 'true');
    primary.focus({ preventScroll: true });
  }

  private content(kind: WorldPopupKind): { title: string; body: HTMLElement[]; actions: HTMLElement[]; primary: HTMLButtonElement } {
    const hint = (text: string) => h('p', { class: 'ui-set__hint ui-world-popup__hint', text });
    const para = (text: string) => h('p', { class: 'ui-world-popup__text', text });
    if (kind === 'waitlist') {
      const ok = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Got it'), attrs: { autofocus: true }, on: { click: () => this.close() } });
      return {
        title: tr("You're on the waitlist"),
        body: [
          para(tr("Access opens gradually, in batches. We'll email you when it's your turn.")),
          hint(tr('Meanwhile, Habblaud works as usual and nothing from the office is sent.')),
        ],
        actions: [ok],
        primary: ok,
      };
    }
    if (kind === 'approved') {
      const create = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Create character'), attrs: { autofocus: true }, on: { click: () => this.go('character') } });
      return {
        title: tr('Access granted!'),
        body: [para(tr("It's your turn: create your character and enter the city."))],
        actions: [create, h('button', { class: 'ui-btn', type: 'button', text: tr('Later'), on: { click: () => this.close() } })],
        primary: create,
      };
    }
    const create = h('button', { class: 'ui-btn ui-btn--primary ui-world-popup__cta', type: 'button', text: tr('Create account'), attrs: { autofocus: true }, on: { click: () => this.go('register') } });
    return {
      title: tr('New: Habblaud World'),
      body: [
        h('p', { class: 'ui-world-popup__lead', text: tr('Your office can now become a building in an online city, lit up while your agents work.') }),
        h(
          'ul',
          { class: 'ui-world-popup__perks' },
          h('li', { text: tr('Your office becomes a building in a pixel-art city, lit up while your agents work.') }),
          h('li', { text: tr("Create a character, walk around the city and visit other people's buildings.") }),
          h('li', { text: tr('Greet passersby and like buildings, with no chat and no spam.') }),
        ),
        h(
          'p',
          { class: 'ui-world-popup__privacy' },
          tr('Nothing about your work leaves your computer: only the theme, how many floors, and whether each character is busy or idle.'),
          ' ',
          extLink(tr('See the list'), WORLD_PRIVACY_URL),
        ),
        hint(tr('Nothing is sent until you create an account. Access opens gradually, through a waitlist.')),
      ],
      actions: [
        create,
        h('button', { class: 'ui-btn', type: 'button', text: tr('Not now'), on: { click: () => this.close() } }),
        h('button', { class: 'ui-link-btn', type: 'button', text: tr("Don't show again"), on: { click: () => this.never() } }),
      ],
      primary: create,
    };
  }

  // ---------------------------------------------------------------- actions

  private go(screen: 'register' | 'character'): void {
    this.close();
    this.hooks.openWorld(screen);
  }

  private never(): void {
    this.remember({ ...this.memory, launch: 'never' });
    this.close();
  }

  private close(): void {
    if (this.el.open) {
      if (typeof this.el.close === 'function') this.el.close();
      else this.el.removeAttribute('open');
    }
    this.el.removeAttribute('aria-modal');
    if (this.open) this.onClosed();
  }

  private onClosed(): void {
    if (!this.open) return;
    this.open = null;
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
    this.ctx.invalidate();
  }

  // ---------------------------------------------------------------- memory

  private load(): WorldPopupMemory {
    try {
      const s = safeLocalStorage();
      if (!s) return { ...EMPTY_POPUP_MEMORY };
      return parsePopupMemory({ launch: s.getItem(LAUNCH_KEY), legacy: s.getItem(INVITE_SEEN_KEY), waitlist: s.getItem(WAITLIST_SEEN_KEY), approved: s.getItem(APPROVED_SEEN_KEY) });
    } catch {
      return { ...EMPTY_POPUP_MEMORY };
    }
  }

  private remember(m: WorldPopupMemory): void {
    this.memory = m;
    try {
      const s = safeLocalStorage();
      if (!s) return;
      const v = serializePopupMemory(m);
      for (const [key, value] of [
        [LAUNCH_KEY, v.launch],
        [WAITLIST_SEEN_KEY, v.waitlist],
        [APPROVED_SEEN_KEY, v.approved],
      ] as const) {
        if (value === null) s.removeItem(key);
        else s.setItem(key, value);
      }
    } catch {
      // Without storage: memory applies only to this page.
    }
  }
}
