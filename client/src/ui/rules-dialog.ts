// 📜 Rules ("Nội quy") of the office shown (shared/rules.ts): a toolbar button (the rules that are on; a red ⚠ when the
// office had violations today; shortcut R) and a dialog in five parts:
// - Scope: the office folder (fixed here; the office dialog changes it), extra folders that may be edited, paths that
//   may not even be read, command prefixes that may not run;
// - Rules: short rules for the boss, the workers or everyone, on/off, add/remove;
// - Limits: jobs running at once, and the quota % at which a worker gets no more jobs;
// - Proposals from the boss: Accept (it becomes a rule) / Reject, saved at once;
// - Log: the refusals of the last days, newest first.
// Save sends the edited copy with the version it started from: if the rules changed meanwhile (409) the dialog reloads
// them and says so. Editable only on this computer (not in the demo).
import type { OfficeInfo } from '../../../shared/types';
import type { OfficeRule, OfficeRules, RuleFor } from '../../../shared/rules';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { relativeTime } from './format';
import { ICONS } from './icons';
import { teamOffices } from './offices';
import { activeRules, draftOf, forLabel, linesOf, newRuleId, rulesProblems, sameDraft, VIOLATION_ICON, violationLabel, violationsToday, type RulesDraft } from './rules-model';
import { shortPath } from './spawn';
import { answerProposal, ApiError, saveRules } from './workers-api';
import { tr } from '../../../shared/i18n';

const FORS: RuleFor[] = ['all', 'boss', 'workers'];

export class RulesDialog implements UiComponent {
  readonly el: HTMLDialogElement;
  /** Toolbar button: shown while the office shown has rules (a server that keeps them). */
  readonly button: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly warn: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly folderEl: HTMLElement;
  private readonly write: HTMLTextAreaElement;
  private readonly deny: HTMLTextAreaElement;
  private readonly commands: HTMLTextAreaElement;
  private readonly itemsEl: HTMLElement;
  private readonly maxJobs: HTMLInputElement;
  private readonly quotaStop: HTMLInputElement;
  private readonly proposalsEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly status: HTMLElement;
  private readonly changed: HTMLElement;
  private readonly save: HTMLButtonElement;
  private readonly revert: HTMLButtonElement;
  /** The office being edited (stays while the dialog is open, even if another tab is picked). */
  private officeId = '';
  /** The version the draft started from. */
  private rev = 0;
  private draft: RulesDraft | null = null;
  /** The copy the draft started from (what "edited" compares with). */
  private base: RulesDraft | null = null;
  private busy = false;
  private sig = '';
  /** Just saved: the next version from the server replaces the draft (it may be normalized). */
  private saved = false;

  constructor(private readonly ctx: UiContext) {
    this.count = h('span', { class: 'ui-btn-board__count ui-btn-rules__count' });
    this.warn = h('span', { class: 'ui-btn-rules__warn', text: '⚠', attrs: { 'aria-hidden': 'true' } });
    this.button = iconButton(ICONS.rules, tr('Rules (R)'), () => this.toggle(), 'ui-btn-rules');
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.append(this.count, this.warn);
    this.button.hidden = true;

    this.titleEl = h('h2', { attrs: { id: 'ui-rules-title' } });
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    const area = (label: string, placeholder: string) => {
      const t = h('textarea', { class: 'ui-rules__area', attrs: { rows: 2, placeholder, 'aria-label': label, spellcheck: 'false' } });
      t.addEventListener('input', () => this.readForm());
      return t;
    };
    this.folderEl = h('p', { class: 'ui-rules__folder' });
    this.write = area(tr('Also editable'), tr('One folder per line, e.g. ~/notes'));
    this.deny = area(tr('Never read or edit'), tr('One per line: a path (~/.ssh) or a name (.env*)'));
    this.commands = area(tr('Never run'), tr('One command start per line, e.g. git push'));
    this.itemsEl = h('ul', { class: 'ui-rules__items' });
    const addRule = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('＋ Add a rule'), on: { click: () => this.addRule() } });
    const num = (label: string, max: number) => {
      const i = h('input', { class: 'ui-rename__input ui-rules__num', type: 'number', attrs: { min: 1, max, step: 1, placeholder: tr('no limit'), 'aria-label': label } });
      i.addEventListener('input', () => this.readForm());
      return i;
    };
    this.maxJobs = num(tr('Jobs running at once'), 50);
    this.quotaStop = num(tr('Stop giving jobs to a worker at quota %'), 100);
    this.proposalsEl = h('ul', { class: 'ui-rules__proposals' });
    this.logEl = h('ol', { class: 'ui-rules__log' });
    this.status = h('p', { class: 'ui-teamdlg__status ui-muted', role: 'status' });
    this.changed = h('p', { class: 'ui-rules__changed', hidden: true });
    this.revert = h('button', { class: 'ui-btn', type: 'button', text: tr('Undo changes'), on: { click: () => this.load() } });
    this.save = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: tr('Save the rules') });
    const section = (title: string, hint: string, ...children: HTMLElement[]) =>
      h('section', { class: 'ui-rules__part', attrs: { 'data-hint': hint } }, h('h3', { class: 'ui-rules__head', text: title }), ...children);
    const field = (label: string, input: HTMLElement) => h('label', { class: 'ui-rules__field' }, h('span', { class: 'ui-teamdlg__label', text: label }), input);
    const form = h(
      'form',
      {
        class: 'ui-teamdlg__body ui-rules__body',
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            void this.submit();
          },
        },
      },
      section(
        tr('Scope'),
        tr('Where the boss and the workers may edit files, what they may not even read, and the commands they may not run'),
        this.folderEl,
        field(tr('Also editable'), this.write),
        field(tr('Never read or edit'), this.deny),
        field(tr('Never run'), this.commands),
      ),
      section(tr('Rules'), tr('Short rules, put at the top of every job (workers) or of the boss\'s session'), this.itemsEl, addRule),
      section(tr('Limits'), tr('Checked by agy-ask / claude-ask before a job starts'), h('div', { class: 'ui-rules__limits' }, field(tr('Jobs running at once'), this.maxJobs), field(tr('Stop giving jobs to a worker at quota %'), this.quotaStop))),
      section(tr('Proposals from the boss'), tr('The boss cannot change the rules: it proposes, you decide'), this.proposalsEl),
      section(tr('Log'), tr('What the rules refused in the last days, newest first'), this.logEl),
      this.changed,
      this.status,
      h('div', { class: 'ui-teamdlg__actions' }, this.revert, this.save),
    );
    this.el = h('dialog', { class: 'ui-dialog ui-teamdlg ui-rulesdlg', attrs: { 'aria-labelledby': 'ui-rules-title' } }, h('div', { class: 'ui-dialog__head' }, this.titleEl, close), form) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** Opens on an office (default: the one shown). */
  open(officeId?: string): void {
    const office = this.office(officeId ?? this.ctx.selectedOffice()?.id);
    if (!office?.rules) return;
    this.officeId = office.id;
    if (!this.el.open) this.el.showModal();
    this.load();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  render(): void {
    this.renderButton();
    if (!this.el.open) return;
    const office = this.office(this.officeId);
    if (!office?.rules) return this.close();
    const rules = office.rules;
    // Changed elsewhere (another tab, the boss's accepted proposal): reload when nothing was edited, else say so.
    const behind = rules.rev !== this.rev;
    if (behind && (!this.dirty() || this.saved) && !this.busy) {
      this.saved = false;
      const status = this.status.textContent ?? '';
      this.load();
      setText(this.status, status);
      this.status.dataset.err = '1';
      return;
    }
    setHidden(this.changed, !behind);
    setText(this.changed, behind ? tr('The rules were changed elsewhere meanwhile. "Undo changes" loads them (your edits are lost).') : '');
    const sig = JSON.stringify([rules.proposals, office.violations?.slice(0, 50), this.busy, this.locked(), Math.floor(this.ctx.now() / 60_000)]);
    if (sig !== this.sig) {
      this.sig = sig;
      this.renderProposals(office, rules);
      this.renderLog(office);
    }
    this.refresh();
  }

  private office(id: string | undefined): OfficeInfo | undefined {
    return teamOffices(this.ctx.store.snapshot?.team).find((o) => o.id === id);
  }

  /** Why the rules cannot be changed here ('' = they can). */
  private locked(): string {
    if (this.ctx.store.mock) return tr('Not in the demo');
    return this.ctx.store.snapshot?.meta.terminal ? '' : tr('This Habblaud does not let the page run commands');
  }

  private dirty(): boolean {
    return !!this.draft && !!this.base && !sameDraft(this.draft, this.base);
  }

  private renderButton(): void {
    const office = this.ctx.selectedOffice();
    const rules = office?.rules;
    setHidden(this.button, !rules);
    if (!rules) return;
    const n = activeRules(rules);
    const today = violationsToday(office.violations, this.ctx.now()).length;
    setText(this.count, n ? String(n) : '');
    setHidden(this.count, !n || today > 0);
    setHidden(this.warn, !today);
    const label = today ? tr('Rules (R): {0} on · {1} refused today', [n, today]) : tr('Rules (R): {0} on', [n]);
    if (this.button.title !== label) {
      this.button.title = label;
      this.button.setAttribute('aria-label', label);
    }
  }

  /** (Re)loads the office's rules into the form. */
  private load(): void {
    const office = this.office(this.officeId);
    if (!office?.rules) return;
    this.rev = office.rules.rev;
    this.draft = draftOf(office.rules);
    this.base = draftOf(office.rules);
    this.sig = '';
    setText(this.titleEl, teamOffices(this.ctx.store.snapshot?.team).length > 1 ? tr('📜 Rules · {0}', [office.name]) : tr('📜 Rules'));
    setText(this.folderEl, office.folder ? tr('Office folder (always editable): {0}', [shortPath(office.folder)]) : tr('This office has no folder yet: choose it in the office dialog.'));
    this.write.value = this.draft.scope.write.join('\n');
    this.deny.value = this.draft.scope.deny.join('\n');
    this.commands.value = this.draft.scope.commands.join('\n');
    for (const t of [this.write, this.deny, this.commands]) t.rows = Math.max(2, Math.min(6, t.value.split('\n').length));
    this.maxJobs.value = this.draft.limits.maxJobs ? String(this.draft.limits.maxJobs) : '';
    this.quotaStop.value = this.draft.limits.quotaStop ? String(this.draft.limits.quotaStop) : '';
    this.renderItems();
    setText(this.status, '');
    this.status.dataset.err = '';
    this.render();
  }

  /** The form's text fields into the draft (the rule rows write theirs directly). */
  private readForm(): void {
    if (!this.draft) return;
    const n = (i: HTMLInputElement) => (i.value.trim() === '' ? undefined : Number(i.value));
    this.draft.scope = { write: linesOf(this.write.value), deny: linesOf(this.deny.value), commands: linesOf(this.commands.value) };
    const maxJobs = n(this.maxJobs);
    const quotaStop = n(this.quotaStop);
    this.draft.limits = { ...(maxJobs !== undefined ? { maxJobs } : {}), ...(quotaStop !== undefined ? { quotaStop } : {}) };
    this.edited();
  }

  /** An edit: the last message (saved, error) goes, the buttons follow. */
  private edited(): void {
    this.status.dataset.err = '';
    this.refresh();
  }

  private renderItems(): void {
    const items = this.draft?.items ?? [];
    const locked = !!this.locked();
    this.itemsEl.replaceChildren(
      ...items.map((r) => this.ruleRow(r, locked)),
      ...(items.length ? [] : [h('li', { class: 'ui-muted', text: tr('No rules yet.') })]),
    );
  }

  private ruleRow(r: OfficeRule, locked: boolean): HTMLElement {
    const on = h('input', { type: 'checkbox', attrs: { 'aria-label': tr('On') } });
    on.checked = r.on;
    on.disabled = locked;
    on.addEventListener('change', () => {
      r.on = on.checked;
      this.edited();
    });
    const text = h('input', { class: 'ui-rename__input ui-rules__text', type: 'text', attrs: { maxlength: 200, 'aria-label': tr('Rule'), placeholder: tr('A short rule') } });
    text.value = r.text;
    text.disabled = locked;
    text.addEventListener('input', () => {
      r.text = text.value;
      this.edited();
    });
    const who = h('select', { class: 'ui-rules__for', attrs: { 'aria-label': tr('For') } }, ...FORS.map((f) => h('option', { text: forLabel(f), attrs: { value: f } })));
    who.value = r.for;
    who.disabled = locked;
    who.addEventListener('change', () => {
      r.for = who.value as RuleFor;
      this.edited();
    });
    const del = h('button', {
      class: 'ui-icon-btn ui-icon-btn--sm',
      type: 'button',
      text: '🗑',
      title: tr('Remove this rule'),
      attrs: { 'aria-label': tr('Remove this rule') },
      on: {
        click: () => {
          if (!this.draft) return;
          this.draft.items = this.draft.items.filter((x) => x !== r);
          this.renderItems();
          this.edited();
        },
      },
    });
    del.disabled = locked;
    return h('li', { class: `ui-rules__item${r.on ? '' : ' is-off'}` }, on, text, who, del);
  }

  private addRule(): void {
    if (!this.draft || this.locked()) return;
    this.draft.items.push({ id: newRuleId(this.draft.items), text: '', for: 'all', on: true });
    this.renderItems();
    this.itemsEl.querySelector<HTMLInputElement>('.ui-rules__item:last-child .ui-rules__text')?.focus();
    this.edited();
  }

  private renderProposals(office: OfficeInfo, rules: OfficeRules): void {
    const locked = !!this.locked();
    if (!rules.proposals.length) {
      this.proposalsEl.replaceChildren(h('li', { class: 'ui-muted', text: tr('None. A boss proposes with: agy-ask rules propose "…" --why "…"') }));
      return;
    }
    const now = this.ctx.now();
    this.proposalsEl.replaceChildren(
      ...rules.proposals.map((p) => {
        const answer = (accept: boolean) => {
          const b = h('button', { class: `ui-btn ui-btn--sm${accept ? ' ui-btn--primary' : ''}`, type: 'button', text: accept ? tr('Accept') : tr('Reject'), on: { click: () => void this.answer(office.id, p.id, accept) } });
          b.disabled = locked || this.busy;
          return b;
        };
        return h(
          'li',
          { class: 'ui-rules__proposal' },
          h('p', { class: 'ui-rules__ptext', text: p.text }),
          h('p', { class: 'ui-muted ui-rules__pmeta', text: [tr('for {0}', [forLabel(p.for)]), tr('by {0}', [p.by]), p.at ? relativeTime(p.at, now) : '', p.why ? tr('why: {0}', [p.why]) : ''].filter(Boolean).join(' · ') }),
          h('div', { class: 'ui-rules__pact' }, answer(false), answer(true)),
        );
      }),
    );
  }

  private renderLog(office: OfficeInfo): void {
    const list = office.violations ?? [];
    if (!list.length) {
      this.logEl.replaceChildren(h('li', { class: 'ui-muted', text: tr('Nothing refused in the last days.') }));
      return;
    }
    const now = this.ctx.now();
    this.logEl.replaceChildren(
      ...list.map((v) =>
        h(
          'li',
          { class: 'ui-rules__entry', title: `${violationLabel(v.kind)} · ${v.by === 'hook' ? tr('blocked in the session') : tr('job refused')}` },
          h('span', { class: 'ui-rules__icon', text: VIOLATION_ICON[v.kind], attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'ui-rules__who', text: v.who }),
          h('span', { class: 'ui-rules__detail', text: `${violationLabel(v.kind)}: ${v.detail}` }),
          h('time', { class: 'ui-muted ui-rules__time', text: relativeTime(v.at, now), attrs: { datetime: new Date(v.at).toISOString() } }),
        ),
      ),
    );
  }

  /** Buttons and the line under the form (no re-render of the fields). */
  private refresh(): void {
    const office = this.office(this.officeId);
    const locked = this.locked();
    for (const t of [this.write, this.deny, this.commands, this.maxJobs, this.quotaStop]) t.disabled = !!locked;
    const problems = this.draft && office ? rulesProblems(this.draft, office, teamOffices(this.ctx.store.snapshot?.team)) : [];
    const dirty = this.dirty();
    this.save.disabled = this.busy || !!locked || !dirty || problems.length > 0;
    this.revert.disabled = this.busy || (!dirty && !(office?.rules && office.rules.rev !== this.rev));
    setHidden(this.save, !!locked);
    setHidden(this.revert, !!locked);
    if (this.busy || this.status.dataset.err === '1') return;
    setText(this.status, locked || problems.join(' '));
  }

  private async submit(): Promise<void> {
    if (!this.draft || this.save.disabled) return;
    this.readForm();
    const office = this.office(this.officeId);
    if (!office) return;
    this.busy = true;
    setText(this.status, tr('Saving…'));
    this.refresh();
    try {
      await saveRules(office.id, this.draft, this.rev);
      // the snapshot brings the new version (render() loads it)
      this.saved = true;
      this.ctx.announce(tr('Rules of {0} saved.', [office.name]));
      setText(this.status, tr('Saved.'));
      // kept until the next edit
      this.status.dataset.err = '1';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.busy = false;
        this.load();
        setText(this.status, tr('The rules changed meanwhile (the boss or another window): they were reloaded. Check them and save again.'));
      } else setText(this.status, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
      this.status.dataset.err = '1';
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }

  private async answer(office: string, proposal: string, accept: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sig = '';
    try {
      await answerProposal(office, proposal, accept);
      const said = accept ? tr('Proposal accepted: it is a rule now.') : tr('Proposal rejected.');
      this.ctx.announce(said);
      setText(this.status, said);
      this.status.dataset.err = '1';
    } catch (err) {
      setText(this.status, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
      this.status.dataset.err = '1';
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }
}
