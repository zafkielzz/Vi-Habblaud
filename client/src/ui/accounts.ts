// Accounts (toolbar button 👤): the Claude Code and Antigravity accounts on this computer, apart from sessions. Add
// one (Claude: a name becomes ~/.claude-<name>; Antigravity: the next ~/.agy_profiles/accN) or sign in again: each
// opens a sign-in terminal (`claude auth login` or `agy-as accN`, server/http/accounts.ts). Sessions and workers are
// chosen in the sidebar; this window only makes accounts ready for them.
import type { AccountInfo, PtyInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { FIVE_HOURS_MS, usageWindowView, WEEK_MS } from './format';
import { ICONS } from './icons';
import { postPty } from './ptyapi';
import { tr } from '../../../shared/i18n';

/** An Antigravity profile on disk (GET /api/accounts). */
export interface AgyProfileRow {
  acc: string;
  account: string;
  state: 'ready' | 'new' | 'off';
}

/** "5 h 42% · week 10%" from the account's last usage reading; '' without numbers. */
export function usageLine(a: Pick<AccountInfo, 'usage'> | undefined, now: number): string {
  const u = a?.usage;
  if (!u) return '';
  const part = (name: string, win: typeof u.fiveHour, ms: number) => {
    const v = usageWindowView(win, u.fetchedAt, now, ms);
    return v ? `${name} ${v.pct === null ? v.reset : `${Math.round(v.pct)}%`}` : '';
  };
  return [u.noFiveHour ? '' : part(tr('5 h'), u.fiveHour, FIVE_HOURS_MS), part(tr('week'), u.sevenDay, WEEK_MS)].filter(Boolean).join(' · ');
}

/** Accounts this close to a limit (5 h or week) get the ⚠ on the 👤 button and an orange/red quota bar. */
export const USAGE_WARN = 80;

/** The fuller of the account's windows (5 h, week), in %; null without numbers (usageStatus 'disabled' = none yet). */
export function peakUsage(a: Pick<AccountInfo, 'usage'> | undefined, now: number): number | null {
  const u = a?.usage;
  if (!u) return null;
  const pcts = [u.noFiveHour ? null : usageWindowView(u.fiveHour, u.fetchedAt, now, FIVE_HOURS_MS)?.pct, usageWindowView(u.sevenDay, u.fetchedAt, now, WEEK_MS)?.pct];
  const known = pcts.filter((p): p is number => typeof p === 'number');
  return known.length ? Math.max(...known) : null;
}

const hotClass = (a: AccountInfo | undefined, now: number): string => ((peakUsage(a, now) ?? 0) >= USAGE_WARN ? 'is-hot' : '');

/** One usage window of an account, for a quota meter: % used (null = reset since the reading) and when it resets. */
export interface QuotaWindow {
  label: string;
  /** Name in the tooltip ("5-hour limit"). */
  name: string;
  pct: number | null;
  /** "↻ 2 h 10 min" / "↻ Fri, 09:52"; empty when unknown. */
  reset: string;
}

/** The 5-hour window (unless the plan has none) and the weekly one; [] without numbers. */
export function quotaWindows(a: Pick<AccountInfo, 'usage'> | undefined, now: number): QuotaWindow[] {
  const u = a?.usage;
  if (!u) return [];
  const out: QuotaWindow[] = [];
  const add = (label: string, name: string, win: typeof u.fiveHour, ms: number) => {
    const v = usageWindowView(win, u.fetchedAt, now, ms);
    if (v) out.push({ label, name, pct: v.pct, reset: v.reset });
  };
  if (!u.noFiveHour) add(tr('5 h'), tr('5-hour limit'), u.fiveHour, FIVE_HOURS_MS);
  add(tr('week'), tr('weekly limit'), u.sevenDay, WEEK_MS);
  return out;
}

/** Claude account name typed in the dialog (same rule as the server). */
export function validClaudeName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(name);
}

export class AccountsDialog {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  /** "⚠ 2": accounts at USAGE_WARN % or more. */
  private readonly badge: HTMLElement;
  private readonly claudeList: HTMLElement;
  private readonly agyList: HTMLElement;
  private readonly status: HTMLElement;
  private readonly nameForm: HTMLFormElement;
  private readonly nameInput: HTMLInputElement;
  private profiles: AgyProfileRow[] = [];
  private sig = '';
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private ctx: UiContext) {
    this.badge = h('span', { class: 'ui-btn-accounts__warn', hidden: true });
    this.button = h(
      'button',
      {
        class: 'ui-icon-btn ui-btn-accounts',
        type: 'button',
        title: tr('Accounts: usage, add or sign in Claude and Antigravity accounts'),
        on: { click: () => this.toggle() },
        attrs: { 'aria-haspopup': 'dialog', 'data-hint': tr('Accounts: 5-hour and weekly usage of each account; ⚠ = an account at {0}% or more', [USAGE_WARN]) },
      },
      h('span', { text: '👤', attrs: { 'aria-hidden': 'true' } }),
      this.badge,
    );
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.claudeList = h('ul', { class: 'ui-accounts__list' });
    this.agyList = h('ul', { class: 'ui-accounts__list' });
    this.status = h('p', { class: 'ui-accounts__status ui-muted', role: 'status' });
    this.nameInput = h('input', { class: 'ui-accounts__name', type: 'text', attrs: { placeholder: tr('name, e.g. work'), maxlength: 31, 'aria-label': tr('Account name') } });
    this.nameForm = h(
      'form',
      { class: 'ui-accounts__form', hidden: true, on: {
          submit: (e: Event) => {
            e.preventDefault();
            void this.addClaude();
          },
        },
      },
      h('span', { class: 'ui-muted', text: '~/.claude-' }),
      this.nameInput,
      h('button', { class: 'ui-btn', type: 'submit', text: tr('Create and sign in') }),
    ) as HTMLFormElement;
    const addClaude = h('button', {
      class: 'ui-btn',
      type: 'button',
      text: tr('＋ Add Claude account'),
      attrs: { 'data-hint': tr('Makes a new Claude Code account folder and opens a terminal to sign in to it.') },
      on: {
        click: () => {
          this.nameForm.hidden = !this.nameForm.hidden;
          if (!this.nameForm.hidden) this.nameInput.focus();
        },
      },
    });
    const addAgy = h('button', {
      class: 'ui-btn',
      type: 'button',
      text: tr('＋ Add Antigravity account'),
      attrs: { 'data-hint': tr('Makes the next Antigravity profile (accN) and opens agy in it to sign in with Google.') },
      on: { click: () => void this.run('/api/accounts/agy', {}) },
    });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-accounts', attrs: { 'aria-labelledby': 'ui-accounts-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { attrs: { id: 'ui-accounts-title' }, text: tr('👤 Accounts') }), close),
      h(
        'div',
        { class: 'ui-accounts__body' },
        h('p', { text: tr('Sign in each account once here. The boss and the workers can be Claude Code or Antigravity accounts (choose them with ＋ in the sidebar); other sessions run on Claude accounts.') }),
        h('h3', { text: 'Claude Code' }),
        this.claudeList,
        h('div', { class: 'ui-accounts__actions' }, addClaude),
        this.nameForm,
        h('h3', { text: 'Antigravity' }),
        this.agyList,
        h('div', { class: 'ui-accounts__actions' }, addAgy),
        this.status,
      ),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => {
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    this.sig = '';
    setText(this.status, '');
    this.nameForm.hidden = true;
    void this.load();
    // A sign-in finishing elsewhere (the terminal) shows up here without reopening.
    this.poll ??= setInterval(() => void this.load(), 10_000);
    this.render();
    if (!this.el.open) this.el.showModal();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  render(): void {
    this.renderBadge();
    if (!this.el.open) return;
    const snap = this.ctx.store.snapshot;
    const now = this.ctx.now();
    const accounts = snap?.accounts ?? [];
    const pty = !!snap?.meta.pty?.enabled;
    const sig = JSON.stringify([accounts.map((a) => [a.id, a.name, a.email, a.plan, usageLine(a, now)]), this.profiles, pty]);
    if (sig === this.sig) return;
    this.sig = sig;
    const why = pty ? '' : tr('Needs the interactive terminal (start Habblaud with HABBLAUD_PTY=1).');
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.ui-accounts__actions .ui-btn, .ui-accounts__form .ui-btn')) {
      b.disabled = !pty;
      b.title = why;
    }

    const claude = accounts.filter((a) => (a.provider ?? 'claude') === 'claude');
    this.claudeList.replaceChildren(
      ...(claude.length
        ? claude.map((a) => this.row(a.name, a.email ?? tr('not signed in'), usageLine(a, now), a.color, this.loginButton(a.id, a.email ? tr('Sign in again') : tr('Sign in'), why), hotClass(a, now)))
        : [h('li', { class: 'ui-muted', text: tr('No Claude Code account yet.') })]),
    );

    const agyRows = this.profiles.map((p) => {
      const a = accounts.find((x) => x.id === p.account);
      const name = a?.name ?? p.acc;
      if (p.state === 'off') return this.row(name, tr('off: vacant in roles.conf'), '', a?.color, null, 'is-off');
      if (p.state === 'new') return this.row(name, tr('sign-in not finished'), '', a?.color, this.loginButton(p.account, tr('Finish sign-in'), why), 'is-new');
      return this.row(name, a?.email ?? p.acc, usageLine(a, now), a?.color, this.loginButton(p.account, tr('Sign in again'), why), hotClass(a, now));
    });
    this.agyList.replaceChildren(...(agyRows.length ? agyRows : [h('li', { class: 'ui-muted', text: tr('No Antigravity account yet.') })]));
  }

  /** ⚠ on the button: how many accounts are close to (or at) a limit, named in the tooltip. */
  private renderBadge(): void {
    const now = this.ctx.now();
    const hot = (this.ctx.store.snapshot?.accounts ?? []).filter((a) => (peakUsage(a, now) ?? 0) >= USAGE_WARN);
    setHidden(this.badge, !hot.length);
    setText(this.badge, hot.length ? `⚠${hot.length}` : '');
    this.button.classList.toggle('is-warn', hot.length > 0);
    this.button.title = hot.length
      ? tr('Accounts: {0} at {1}% or more of a limit: {2}', [hot.length, USAGE_WARN, hot.map((a) => `${a.name} (${Math.round(peakUsage(a, now)!)}%)`).join(', ')])
      : tr('Accounts: usage, add or sign in Claude and Antigravity accounts');
  }

  private row(name: string, sub: string, usage: string, color: string | undefined, action: HTMLElement | null, cls = ''): HTMLElement {
    const dot = h('span', { class: 'ui-accounts__dot', attrs: { 'aria-hidden': 'true' } });
    if (color) dot.style.background = color;
    return h(
      'li',
      { class: `ui-accounts__item ${cls}`.trim() },
      dot,
      h('div', { class: 'ui-accounts__who' }, h('strong', { text: name }), h('span', { class: 'ui-muted', text: sub })),
      h('span', { class: 'ui-accounts__usage ui-muted', text: usage }),
      action,
    );
  }

  private loginButton(account: string, label: string, why: string): HTMLButtonElement {
    return h('button', {
      class: 'ui-btn ui-btn--sm',
      type: 'button',
      text: label,
      title: why,
      attrs: why ? { disabled: true } : {},
      on: { click: () => void this.run('/api/accounts/login', { account }) },
    });
  }

  private async load(): Promise<void> {
    try {
      const r = await fetch('/api/accounts');
      if (!r.ok) return;
      this.profiles = ((await r.json()) as { agy?: AgyProfileRow[] }).agy ?? [];
      this.render();
    } catch {
      // offline: keep the last list
    }
  }

  private async addClaude(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!validClaudeName(name)) {
      setText(this.status, tr('Account name: letters, digits, - or _ (up to 31)'));
      return this.nameInput.focus();
    }
    if (await this.run('/api/accounts/claude', { name })) {
      this.nameInput.value = '';
      this.nameForm.hidden = true;
    }
  }

  /** Calls the route and opens the sign-in terminal it returns. */
  private async run(url: string, body: Record<string, unknown>): Promise<boolean> {
    setText(this.status, tr('Opening the sign-in terminal…'));
    try {
      const r = await postPty<{ account: string; pty: PtyInfo }>(url, { ...body, cols: 120, rows: 32 });
      if (!r) return false;
      setText(this.status, tr('Sign in to {0} in the terminal. It shows up here when done.', [r.account]));
      void this.load();
      this.close();
      this.ctx.terminals?.showPty?.(r.pty);
      return true;
    } catch (err) {
      setText(this.status, tr("Didn't work: {0}", [(err as Error).message]));
      return false;
    }
  }
}
