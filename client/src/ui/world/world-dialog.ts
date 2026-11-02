// Habblaud World dialog: modal <dialog> (top layer, backdrop darkened, focus trapped, Esc closes) with dedicated
// top bar button (city icon, only with world server configured) and also opened via "in the world" / "paused" chip
// next to version, launch popups ("Create account", "Create character"), and "While you were away" notice. Content is
// WorldSettingsGroup (settings-world.ts): account, waitlist, character, "Your building", devices, account and data,
// blocked, and sign out. Header features pixel building, title, account status chip, and close button; body scrolls.
// Appearance › Theme note still comes from the group (themeNote/onThemePicked), so group lives here and popover only
// receives both.
//
// Two modals simultaneously (waitlist popup right after registration, or "See what was sent"): showModal() stacks on
// top layer, Esc closes only topmost, and focus returns to this dialog when it closes.
import { tr } from '../../../../shared/i18n';
import type { WorldSource, WorldThemeChoice } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, iconButton, setHidden } from '../dom';
import { ICONS } from '../icons';
import { WorldSettingsGroup, worldGate } from './settings-world';
import { WORLD_BUILDING_ICON } from './world-popups';
import { worldSectionMode, type WorldScreen } from './world-model';

const TITLE_ID = 'ui-world-dialog-title';

/** What Settings needs from World: theme note in Appearance and sending chosen theme to building. */
export interface WorldThemeLink {
  readonly themeNote: HTMLElement;
  onThemePicked(theme: WorldThemeChoice): Promise<void>;
}

export class WorldDialog implements UiComponent, WorldThemeLink {
  readonly el: HTMLDialogElement;
  private readonly group: WorldSettingsGroup;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  /** Element with focus before opening (top bar button, chip…): returns focus there on close. */
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    /** Top bar button: hidden without configured world server, receives aria-expanded. */
    private readonly button: HTMLElement,
  ) {
    this.group = new WorldSettingsGroup(ctx, src);
    const badge = h('span', { class: 'ui-world-dialog__badge', attrs: { 'aria-hidden': 'true' } });
    badge.innerHTML = WORLD_BUILDING_ICON;
    this.title = h('h2', { class: 'ui-world-dialog__title', text: tr('Habblaud World'), tabIndex: -1, attrs: { id: TITLE_ID } });
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.body = h('div', { class: 'ui-world-dialog__body' }, this.group.el);
    this.el = h(
      'dialog',
      // `aria-modal` only while open (closed, <dialog> stays in DOM and must not appear as an open modal).
      { class: 'ui-world-dialog', attrs: { 'aria-labelledby': TITLE_ID } },
      h('div', { class: 'ui-world-dialog__head' }, badge, h('div', { class: 'ui-world-dialog__heading' }, this.title, this.group.chip), close),
      this.body,
    );
    // Backdrop click (outside content) closes.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // Keyboard trapped inside dialog: office shortcuts don't fire underneath. Esc closes (modal <dialog>
    // does this already; without showModal, handled here) and does not reach shortcuts.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Escape' || typeof this.el.showModal === 'function') return;
      e.preventDefault();
      this.close();
    });
    this.el.addEventListener('close', () => this.onClosed());
  }

  get themeNote(): HTMLElement {
    return this.group.themeNote;
  }

  onThemePicked(theme: WorldThemeChoice): Promise<void> {
    return this.group.onThemePicked(theme);
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** Opens (if closed) and, with `screen`, navigates to requested screen (register, character, building…). */
  show(screen?: WorldScreen, opener?: HTMLElement | null): void {
    this.group.show(screen);
    if (this.el.open) return;
    this.opener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (typeof this.el.showModal === 'function') this.el.showModal();
    else this.el.setAttribute('open', '');
    this.el.setAttribute('aria-modal', 'true');
    this.button.setAttribute('aria-expanded', 'true');
    this.body.scrollTop = 0;
    // Focus starts on title (screen reader announces dialog); screens with forms shift focus to first field.
    this.title.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(opener?: HTMLElement | null): void {
    if (this.el.open) this.close();
    else this.show(undefined, opener);
  }

  close(): void {
    if (!this.el.open) return;
    this.el.removeAttribute('aria-modal');
    if (typeof this.el.close === 'function') this.el.close();
    else {
      this.el.removeAttribute('open');
      this.onClosed();
    }
  }

  private onClosed(): void {
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
    this.ctx.invalidate();
  }

  render(): void {
    // Without configured world server (or via mobile port), button is not displayed.
    const hidden = worldSectionMode(this.src.meta(), worldGate(this.ctx, this.src)) === 'hidden';
    setHidden(this.button, hidden);
    if (hidden && this.el.open) this.close();
    this.group.render(this.el.open);
  }
}
