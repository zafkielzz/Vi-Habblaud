// Character editor in agent drawer: name, "Randomize", and parts (skin, hair, clothes...) with full-body
// preview (appearance-fields.ts, same as Habblaud World character). "Save" writes project character
// (the room) to server; pure rules (when visible, labels, what goes into `parts`) live in character-model.ts.
import { NAME_MAX } from '../../../shared/appearance';
import type { AgentInfo } from '../../../shared/types';
import { appearanceFromSeed } from '../art';
import type { Appearance } from '../art/api';
import { AppearanceFields } from './appearance-fields';
import { canEditCharacter, changedParts } from './character-model';
import type { UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export class CharacterEditor {
  /** "Edit character" pencil, next to name at top of drawer. */
  readonly button: HTMLButtonElement;
  /** Editor panel (hidden when not editing). */
  readonly el: HTMLElement;
  private agentId = '';
  private editId = 0;
  private editing = false;
  private busy = false;
  private confirmingReset = false;
  private seed = 0;
  private look: 'f' | 'm' = 'f';
  /** Seed-generated base appearance (without parts): unchanged properties are omitted from `parts`. */
  private base: Appearance | null = null;
  private readonly fields = new AppearanceFields();
  private readonly nameInput: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;

  constructor(private ctx: UiContext) {
    this.button = iconButton(ICONS.pencil, tr('Edit character'), () => (this.editing ? this.cancel() : this.start()), 'ui-icon-btn--sm ui-char-edit');
    setAttr(this.button, 'aria-expanded', 'false');
    this.button.hidden = true;

    this.nameInput = h('input', { class: 'ui-char__name', type: 'text', attrs: { maxlength: NAME_MAX, autocomplete: 'off', spellcheck: 'false' } });
    const roll = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Randomize'), title: tr('Randomize another look (undoes the pieces you chose)'), on: { click: () => this.roll() } });
    this.error = h('p', { class: 'ui-char__error', role: 'alert', hidden: true });
    this.saveBtn = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('Save'), on: { click: () => void this.save() } });
    const cancel = h('button', { class: 'ui-btn', type: 'button', text: tr('Cancel'), on: { click: () => this.cancel() } });
    this.resetBtn = h('button', { class: 'ui-link-btn ui-char__reset', type: 'button', text: tr('Back to random'), on: { click: () => void this.reset() } });
    this.el = h(
      'section',
      { class: 'ui-char', hidden: true, attrs: { 'aria-label': tr('Edit character') }, on: { keydown: (ev) => this.onKey(ev) } },
      h(
        'div',
        { class: 'ui-char__top' },
        this.fields.preview,
        h('div', { class: 'ui-char__head' }, h('label', { class: 'ui-char__label' }, h('span', { text: tr('Name') }), this.nameInput), roll),
      ),
      h('p', { class: 'ui-muted ui-small', text: tr('Applies to the project: the next session in this room arrives as this character.') }),
      this.fields.groups,
      this.error,
      h('div', { class: 'ui-char__actions' }, this.saveBtn, cancel, this.resetBtn),
    );
  }

  /** Different agent in drawer: discards in-progress edit. */
  open(id: string): void {
    if (id !== this.agentId) this.close();
    this.agentId = id;
  }

  /** On each drawer render: pencil only appears when editable; editor closes if agent left. */
  render(a: AgentInfo, live: boolean): void {
    const store = this.ctx.store;
    const allowed = canEditCharacter(a, {
      live,
      terminal: !!store.snapshot?.meta.terminal,
      local: access().local,
      replaying: store.replaying,
      mock: store.mock,
    });
    setHidden(this.button, !allowed);
    if (this.editing && !allowed) {
      this.close();
      if (!live || a.status === 'offline') this.ctx.announce(tr('The agent left the office.'));
    }
    if (this.editing && !this.confirmingReset) setHidden(this.resetBtn, !a.custom);
  }

  private start(): void {
    const a = this.ctx.agent(this.agentId);
    if (!a) return;
    this.editId++;
    this.seed = a.seed;
    this.look = a.look;
    this.base = appearanceFromSeed(a.seed, { look: a.look });
    this.nameInput.value = a.name;
    this.confirmingReset = false;
    setText(this.resetBtn, tr('Back to random'));
    setHidden(this.resetBtn, !a.custom);
    this.showError(null);
    this.editing = true;
    setHidden(this.el, false);
    setAttr(this.button, 'aria-expanded', 'true');
    this.fields.set({ ...this.base, ...a.parts });
    this.nameInput.focus();
    this.nameInput.select();
  }

  /** Closes editor and discards draft (also when drawer closes or switches agent). */
  close(): void {
    if (!this.editing) return;
    this.editing = false;
    this.busy = false;
    this.saveBtn.disabled = false;
    setHidden(this.el, true);
    setAttr(this.button, 'aria-expanded', 'false');
  }

  private cancel(): void {
    this.close();
    this.button.focus();
  }

  private roll(): void {
    this.seed = randomSeed();
    this.base = appearanceFromSeed(this.seed, { look: this.look });
    this.fields.set({ ...this.base });
  }

  private async save(): Promise<void> {
    const draft = this.fields.value;
    if (this.busy || !this.base || !draft) return;
    const name = this.nameInput.value.trim();
    if (!name) return this.showError(tr('Give the character a name.'));
    const id = this.agentId;
    const editId = this.editId;
    this.busy = true;
    this.saveBtn.disabled = true;
    const err = await this.ctx.store.saveCharacter(id, { name, seed: this.seed, parts: changedParts(this.base, draft) });
    if (!this.editing || this.agentId !== id || this.editId !== editId) return;
    this.busy = false;
    this.saveBtn.disabled = false;
    if (err) return this.showError(err);
    this.close();
    this.button.focus();
    this.ctx.announce(tr('Character saved: {0}.', [name]));
  }

  private async reset(): Promise<void> {
    if (this.busy) return;
    if (!this.confirmingReset) {
      this.confirmingReset = true;
      setText(this.resetBtn, tr('Confirm: back to random'));
      return;
    }
    const id = this.agentId;
    const editId = this.editId;
    this.busy = true;
    const err = await this.ctx.store.resetCharacter(id);
    if (!this.editing || this.agentId !== id || this.editId !== editId) return;
    this.busy = false;
    if (err) return this.showError(err);
    this.close();
    this.button.focus();
    this.ctx.announce(tr('The character is back to random.'));
  }

  private showError(message: string | null): void {
    setText(this.error, message ?? '');
    setHidden(this.error, !message);
    if (message) this.nameInput.focus();
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      this.cancel();
    } else if (ev.key === 'Enter' && ev.target === this.nameInput) {
      ev.preventDefault();
      void this.save();
    }
  }
}
