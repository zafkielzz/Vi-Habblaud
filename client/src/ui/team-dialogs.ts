// "＋" of the sidebar's Boss and Workers groups (ui/sidebar.ts). The team itself lives in ~/.agy_profiles/team.json,
// edited by the server (POST /api/team, server/team.ts) and read by agy-ask / claude-ask, which enforce it.
// - ＋ Boss: a Claude Code session (a logged-in Claude account and a folder -> a new session in the browser terminal,
//   appointed right away, pending until it shows up) or an Antigravity terminal (`{bossAgy}`: the server opens
//   `agy-as accN` and appoints it). The current boss moves to Others; an Antigravity account that was a worker leaves
//   Workers (agy-ask knows an Antigravity boss by its profile, so its account is never both).
// - ＋ Worker: two groups (workers-api.ts workerChoiceGroups). "Add an account": a logged-in Antigravity or Claude
//   account that is not in the office yet -> registered. "Clone a session": an account that is already a worker of the
//   office, or the boss's own -> one more session of the same account (a clone, "#2", "#3"…).
// Both act on the office shown (ui/offices.ts): the boss opens in the office's folder (an office without one declares
// it here first); a worker of another office can join this one too (workers are shared); an Antigravity account that
// is the boss of an office is not offered.
import type { AccountInfo, OfficeInfo, WorkerKind } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { segmented } from './settings';
import { loadFolders, shortPath, spawnFolders, type FolderOption } from './spawn';
import { createAccountChip, updateAccountChip } from './widgets';
import { appointAgyBoss, appointBoss, setOfficeFolder, setWorker, workerChoiceGroups, workerChoices, type WorkerChoice } from './workers-api';
import { agyBossOffice, folderProblem, officeBoss, otherOfficesOf, teamOffices } from './offices';
import { tr } from '../../../shared/i18n';
import { cloneSuffix, workerBase } from '../../../shared/workers';

type Kind = 'boss' | 'workers';

/** Claude Code accounts a boss can be opened with. */
export function claudeAccounts(accounts: readonly AccountInfo[]): AccountInfo[] {
  return accounts.filter((a) => (a.provider ?? 'claude') === 'claude');
}

function kindLabel(kind: WorkerKind): string {
  return kind === 'claude' ? 'Claude Code' : 'Antigravity';
}

/** Why a folder cannot be the office's, in words ('' = it can); see folderProblem. */
export function folderWhy(problem: string): string {
  if (!problem) return '';
  if (problem === 'empty') return tr('Choose the project folder.');
  if (problem === 'relative') return tr('Write the full path (starting with /).');
  if (problem === 'root') return tr('Not the whole disk: pick a project folder.');
  const [kind, name] = [problem.slice(0, problem.indexOf(':')), problem.slice(problem.indexOf(':') + 1)];
  return tr('The office {0} already works in this folder.', [name]);
}

/**
 * Recent folders as radio buttons (＋ Boss, ＋ Office, an office's folder). `taken`: the office already working in a
 * folder (that folder cannot be picked).
 */
export function folderChoices(opts: readonly FolderOption[], selected: string, onPick: (path: string) => void, taken?: (path: string) => string): HTMLElement {
  return h(
    'div',
    { class: 'ui-spawn__folders', role: 'radiogroup', attrs: { 'aria-label': tr('Folder') } },
    ...opts.map((f) => {
      const on = f.path === selected;
      const by = f.path && taken ? taken(f.path) : '';
      const b = h(
        'button',
        { class: `ui-spawn__folder${on ? ' is-on' : ''}`, type: 'button', role: 'radio', attrs: { 'aria-checked': String(on), title: f.path }, on: { click: () => onPick(f.path) } },
        h('span', { class: 'ui-spawn__folder-name', text: f.name }),
        f.path ? h('span', { class: 'ui-spawn__folder-path', text: by ? tr('office {0}', [by]) : shortPath(f.path) }) : null,
      );
      b.disabled = !!by;
      return b;
    }),
  );
}

/** The office (name) already working in this folder, other than `except`; '' = free. */
export function folderTaken(offices: readonly OfficeInfo[], except?: string): (path: string) => string {
  return (path) => {
    const p = folderProblem(offices, path, except);
    return /^(used|inside|contains):/.test(p) ? p.slice(p.indexOf(':') + 1) : '';
  };
}

export class TeamDialogs implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly titleEl: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly bossKindSeg: ReturnType<typeof segmented<WorkerKind>>;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly submit: HTMLButtonElement;
  private kind: Kind = 'boss';
  private sig = '';
  private busy = false;
  // ＋ Boss choices
  private bossKind: WorkerKind = 'claude';
  /** Claude account (AccountInfo.id). */
  private account = '';
  /** Antigravity profile (accN). */
  private agyAcc = '';
  /** '' = the default folder (Claude: the first recent project; Antigravity: the workers room). */
  private folder = '';
  private folders: FolderOption[] = [];
  private readonly other: HTMLInputElement;

  constructor(private ctx: UiContext) {
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.titleEl = h('h2', { attrs: { id: 'ui-teamdlg-title' } });
    this.intro = h('p', { class: 'ui-teamdlg__intro' });
    this.bossKindSeg = segmented<WorkerKind>(
      tr('Boss'),
      [
        ['claude', 'Claude Code'],
        ['agy', 'Antigravity'],
      ],
      (v) => {
        this.bossKind = v;
        this.folder = '';
        this.sig = '';
        this.render();
      },
    );
    this.body = h('div', { class: 'ui-teamdlg__choices' });
    this.status = h('p', { class: 'ui-teamdlg__status ui-muted', role: 'status' });
    this.other = h('input', {
      class: 'ui-rename__input ui-teamdlg__other',
      type: 'text',
      attrs: { placeholder: tr('Other folder (full path)'), 'aria-label': tr('Other folder (full path)'), autocomplete: 'off', spellcheck: 'false' },
    });
    this.other.addEventListener('input', () => {
      this.folder = this.other.value.trim();
      this.sig = '';
      this.render();
    });
    this.submit = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('👑 Open and appoint'), on: { click: () => void this.openBoss() } });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-teamdlg', attrs: { 'aria-labelledby': 'ui-teamdlg-title' } },
      h('div', { class: 'ui-dialog__head' }, this.titleEl, close),
      h('div', { class: 'ui-teamdlg__body' }, this.intro, this.bossKindSeg.row, this.body, this.status, h('div', { class: 'ui-teamdlg__actions' }, this.submit)),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    // Typing in the dialog does not reach the office shortcuts.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /** Why "＋ Boss" cannot open a terminal here, or '' when it can. */
  bossBlocked(): string {
    if (!this.ctx.terminals?.interactiveEnabled) return tr('Terminals in the browser are off (start Habblaud with HABBLAUD_PTY=1); appoint an open session with 👑 Make boss instead.');
    const snap = this.ctx.store.snapshot;
    if (!claudeAccounts(snap?.accounts ?? []).length && !snap?.team?.agy.length) return tr('No account found: add one with the Accounts button.');
    return '';
  }

  open(kind: Kind, opener?: HTMLElement): void {
    this.kind = kind;
    this.sig = '';
    this.busy = false;
    setText(this.status, '');
    if (kind === 'boss') {
      const snap = this.ctx.store.snapshot;
      const accounts = claudeAccounts(snap?.accounts ?? []);
      const agy = snap?.team?.agy ?? [];
      const boss = officeBoss(snap, this.ctx.selectedOffice());
      if (!accounts.some((a) => a.id === this.account)) this.account = (boss && accounts.find((a) => a.id === boss.account)?.id) ?? accounts[0]?.id ?? '';
      const free = agy.filter((p) => !this.agyTaken(p.account));
      if (!free.some((p) => p.acc === this.agyAcc)) this.agyAcc = free[0]?.acc ?? '';
      if (!agy.length) this.bossKind = 'claude';
      else if (!accounts.length) this.bossKind = 'agy';
      if (!this.folders.length) this.folders = spawnFolders(snap).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path, lastAt: 0 }));
      void this.fetchFolders();
    }
    // Open first: render() draws only an open dialog (else ＋ Worker right after ＋ Boss kept the boss's content).
    if (!this.el.open) this.el.showModal();
    this.render();
    opener?.blur();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  render(): void {
    if (!this.el.open) return;
    const snap = this.ctx.store.snapshot;
    const team = snap?.team;
    const office = this.ctx.selectedOffice();
    const sig = JSON.stringify([this.kind, this.bossKind, this.account, this.agyAcc, this.folder, this.busy, this.folders.length, snap?.accounts.map((a) => a.id), team?.workers, team?.agy, team?.claude, team?.bossAccount, team?.offices, office?.id, officeBoss(snap, office)?.id]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (this.kind === 'boss') this.renderBoss();
    else this.renderWorkers();
  }

  // ---------------------------------------------------------------- ＋ Boss

  private renderBoss(): void {
    const snap = this.ctx.store.snapshot;
    const team = snap?.team;
    const office = this.ctx.selectedOffice();
    const offices = teamOffices(team);
    const boss = officeBoss(snap, office);
    const agy = this.bossKind === 'agy';
    setText(this.titleEl, office && offices.length > 1 ? tr('👑 New boss of {0}', [office.name]) : tr('👑 New boss'));
    const how = agy
      ? tr('Opens the Antigravity account in a browser terminal, where you talk to it; it becomes the boss right away.')
      : tr('Opens a new Claude Code session in the browser terminal; it becomes the boss as soon as it starts.');
    setText(this.intro, boss ? `${how} ${tr('The current boss, {0}, moves to Others.', [boss.name])}` : how);
    // An Antigravity boss needs a team with Antigravity accounts (an older server only knows Claude bosses).
    setHidden(this.bossKindSeg.row, !team?.agy.length);
    this.bossKindSeg.set(this.bossKind);
    const blocked = this.bossBlocked();

    let accountList: HTMLElement;
    let leaves = '';
    if (agy) {
      accountList = this.radioList(
        tr('Antigravity account'),
        (team?.agy ?? []).map((p) => {
          const taken = this.agyTaken(p.account);
          return { id: p.acc, account: this.ctx.account(p.account), fallback: p.account, sub: taken ? tr('boss of {0}', [taken.name]) : p.acc, disabled: !!taken };
        }),
        this.agyAcc,
        (id) => (this.agyAcc = id),
        'agy',
      );
      if ((office?.workers ?? team?.workers)?.some((w) => workerBase(w) === this.agyAcc)) leaves = tr('{0} is a worker now: it leaves Workers (an Antigravity account is never both).', [this.ctx.account(team?.agy.find((p) => p.acc === this.agyAcc)?.account ?? '')?.name ?? this.agyAcc]);
    } else {
      accountList = this.radioList(
        tr('Claude account'),
        claudeAccounts(snap?.accounts ?? []).map((a) => ({ id: a.id, account: a, fallback: a.id, sub: a.email ?? '' })),
        this.account,
        (id) => (this.account = id),
      );
    }
    // The office's folder: fixed once declared; an office without one picks it here (it is declared on open).
    const fixed = office?.folder ?? '';
    const folder = this.folderFor();
    const problem = fixed || (agy && !folder) ? '' : folderWhy(folderProblem(offices, folder, office?.id));
    let folderPart: HTMLElement[];
    if (fixed) {
      folderPart = [h('p', { class: 'ui-teamdlg__fixed', title: fixed }, h('span', { text: `📁 ${fixed.split(/[\\/]/).pop() || fixed}` }), h('span', { class: 'ui-muted', text: shortPath(fixed) }))];
    } else {
      const folderOpts: FolderOption[] = agy ? [{ path: '', name: tr('Workers room (default)'), lastAt: 0 }, ...this.folders] : this.folders;
      if (folderOpts.some((f) => f.path === folder)) this.other.value = '';
      folderPart = [
        ...(office && team?.offices ? [h('p', { class: 'ui-teamdlg__note', text: tr('{0} has no folder yet: the one you choose becomes its folder.', [office.name]) })] : []),
        folderChoices(folderOpts, folder, (path) => this.pick(path), folderTaken(offices, office?.id)),
        this.other,
      ];
    }
    this.body.replaceChildren(
      h('p', { class: 'ui-teamdlg__label', text: agy ? tr('Antigravity account') : tr('Claude account') }),
      accountList,
      ...(leaves ? [h('p', { class: 'ui-teamdlg__note', text: leaves })] : []),
      h('p', { class: 'ui-teamdlg__label', text: fixed ? tr("Office's folder") : tr('Folder') }),
      ...folderPart,
    );
    setHidden(this.submit, false);
    this.submit.disabled = this.busy || !!blocked || !!problem || (agy ? !this.agyAcc || !!this.agyTaken(team?.agy.find((p) => p.acc === this.agyAcc)?.account ?? '') : !this.account || !folder);
    // Why it cannot open yet (cleared once fixed; an error from the last try stays until then).
    const why = blocked || (this.folder ? problem : '');
    if (!this.busy && (why || this.status.dataset.auto)) {
      setText(this.status, why);
      this.status.dataset.auto = why ? '1' : '';
    }
  }

  /** The chosen folder: the office's when declared; a Claude boss needs a real one (the first recent project by default). */
  private folderFor(): string {
    const fixed = this.ctx.selectedOffice()?.folder;
    if (fixed) return fixed;
    if (this.bossKind === 'claude' && !this.folder) return this.folders.find((f) => !folderProblem(teamOffices(this.ctx.store.snapshot?.team), f.path, this.ctx.selectedOffice()?.id))?.path ?? '';
    return this.folder;
  }

  /** The other office whose boss is this Antigravity account (it cannot be boss here too), if any. */
  private agyTaken(account: string): OfficeInfo | undefined {
    const o = account ? agyBossOffice(teamOffices(this.ctx.store.snapshot?.team), account) : undefined;
    return o && o.id !== this.ctx.selectedOffice()?.id ? o : undefined;
  }

  private radioList(
    label: string,
    items: Array<{ id: string; account: AccountInfo | undefined; fallback: string; sub: string; disabled?: boolean }>,
    selected: string,
    onPick: (id: string) => void,
    provider?: 'agy',
  ): HTMLElement {
    return h(
      'div',
      { class: 'ui-teamdlg__accounts', role: 'radiogroup', attrs: { 'aria-label': label } },
      ...items.map((it) => {
        const on = it.id === selected;
        const chip = createAccountChip('sm');
        updateAccountChip(chip, it.account, it.fallback, provider);
        const pick = () => {
          onPick(it.id);
          this.sig = '';
          this.render();
        };
        const b = h(
          'button',
          { class: `ui-teamdlg__account${on ? ' is-on' : ''}`, type: 'button', role: 'radio', attrs: { 'aria-checked': String(on) }, title: it.sub || it.fallback, on: { click: pick } },
          chip,
          h('span', { class: 'ui-teamdlg__account-name', text: it.account?.name ?? it.fallback }),
          it.sub ? h('span', { class: 'ui-teamdlg__account-email ui-muted', text: it.sub }) : null,
        );
        b.disabled = !!it.disabled;
        return b;
      }),
    );
  }

  private pick(path: string): void {
    this.folder = path;
    this.sig = '';
    this.render();
  }

  private async fetchFolders(): Promise<void> {
    const list = await loadFolders();
    if (!list.length) return;
    this.folders = list;
    this.sig = '';
    this.render();
  }

  private async openBoss(): Promise<void> {
    const term = this.ctx.terminals;
    if (this.busy || !term || this.bossBlocked()) return;
    this.busy = true;
    setText(this.status, tr('Opening…'));
    this.render();
    try {
      const office = this.ctx.selectedOffice();
      const folder = this.folderFor();
      // An office without a folder declares the chosen one first (the boss then works there).
      if (office && !office.folder && folder && this.ctx.store.snapshot?.team?.offices) await setOfficeFolder(office.id, folder);
      if (this.bossKind === 'agy') {
        const pty = await appointAgyBoss(this.agyAcc, folder || undefined, office?.id);
        if (pty) term.showPty?.(pty);
      } else {
        const pty = await term.newSession(folder, this.account);
        if (!pty) throw new Error(tr("Habblaud didn't respond"));
        await appointBoss(pty.agentId, pty.account, office?.id);
      }
      this.close();
      this.ctx.announce(tr('New boss opening in the terminal…'));
    } catch (err) {
      setText(this.status, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }

  // ---------------------------------------------------------------- ＋ Worker

  private renderWorkers(): void {
    const team = this.ctx.store.snapshot?.team;
    const office = this.ctx.selectedOffice();
    const offices = teamOffices(team);
    const free = workerChoices(team, team?.offices ? office : undefined);
    setText(this.titleEl, office && offices.length > 1 ? tr('＋ Workers of {0}', [office.name]) : tr('＋ Workers'));
    setText(this.intro, tr('Two ways to get a worker: add an account that is not in this office yet, or clone a session of one that already is. Only workers get jobs, from the boss or from you.'));
    setHidden(this.bossKindSeg.row, true);
    setHidden(this.submit, true);
    if (!team) {
      this.body.replaceChildren(h('p', { class: 'ui-muted', text: tr('This Habblaud server does not keep a team yet (restart it to get one).') }));
      return;
    }
    if (!free.length) {
      this.body.replaceChildren(h('p', { class: 'ui-muted', text: tr('No logged-in account to add. Add accounts with the Accounts button.') }));
      return;
    }
    // The two kinds of a new worker, apart: an account that is new to the office, or one more session of one already there.
    const groups = workerChoiceGroups(free);
    const row = (c: WorkerChoice): HTMLElement => {
      const account = this.ctx.account(c.account);
      const chip = createAccountChip('sm');
      updateAccountChip(chip, account, c.account, c.kind);
      const name = `${account?.name ?? workerBase(c.worker)}${cloneSuffix(c.worker)}`;
      const add = h('button', { class: 'ui-btn', type: 'button', text: c.clone ? tr('＋ Clone') : tr('＋ Add'), on: { click: () => void this.addWorker(c.worker, name, add) } });
      // (workers are shared: one already working for another office can join this one too)
      const also = otherOfficesOf(offices, c.worker, office?.id);
      // Already here, or the boss's own account: one more session of it (a clone).
      const again = c.own ? tr("another session of the boss's account (#{0})", [c.n]) : c.clone && c.n > 1 ? tr('another session of this account (#{0})', [c.n]) : '';
      add.disabled = this.busy;
      return h(
        'li',
        { class: 'ui-teamdlg__account' },
        chip,
        h('span', { class: 'ui-teamdlg__account-name', text: account?.name ?? workerBase(c.worker) }),
        h('span', { class: `ui-teamdlg__kind is-${c.kind}`, text: kindLabel(c.kind) }),
        h('span', { class: 'ui-teamdlg__account-email ui-muted', text: again || (also.length ? tr('also in {0}', [also.join(', ')]) : (account?.email ?? c.worker)) }),
        add,
      );
    };
    const group = (title: string, hint: string, list: WorkerChoice[], none: string): HTMLElement[] => [
      h('p', { class: 'ui-teamdlg__label', text: title }),
      h('p', { class: 'ui-teamdlg__hint ui-muted', text: list.length ? hint : none }),
      ...(list.length ? [h('ul', { class: 'ui-teamdlg__free', attrs: { 'aria-label': title } }, ...list.map(row))] : []),
    ];
    this.body.replaceChildren(
      ...group(tr('Add an account'), tr('An account that is not in this office yet.'), groups.add, tr('Every logged-in account is already in this office.')),
      ...group(
        tr('Clone a session'),
        tr("One more session of an account already in this office, or of the boss's own: its own terminal, the same quota."),
        groups.clone,
        tr('No account in this office yet: add one first.'),
      ),
    );
  }

  private async addWorker(worker: string, name: string, btn: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    btn.disabled = true;
    setText(this.status, '');
    try {
      await setWorker(worker, true, this.ctx.selectedOffice()?.id);
      setText(this.status, tr('{0} is now a worker.', [name]));
    } catch (err) {
      setText(this.status, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }
}
