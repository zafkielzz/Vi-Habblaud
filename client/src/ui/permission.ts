// Respond from the office: permission request card in the agent drawer (Approve, Deny with
// reason, "always allow", and Answer in terminal) or AskUserQuestion questions (options, "Other", and
// Answer), plus the shortcuts leading to it (notice, top bar counter, and the P key). The request arrives
// via the PermissionRequest hook (mod/habblaud-permissoes/hooks/permission-hook.mjs); the dialog continues in
// the terminal and whichever is answered first wins.
// Codex request (`provider: 'codex'`): its hook only waits a few seconds and the terminal only shows the approval
// after you answer here or the timeout expires; there is no "always allow" or "interrupt", and denying requires a
// reason. Codex never asks questions through the office (no question card).
import { access, isLoopbackHostname } from '../net/access';
import { ANSWER_OTHER_MAX, ASK_TOOL, checkAnswers } from '../../../shared/answers';
import type { AgentInfo, AskQuestion, PermissionAnswer, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { formatClock, formatDuration } from './format';
import { ICONS } from './icons';
import { diffLineKind, moreLabel, previewText, showToolInput, splitToolTitle } from './terminal';
import { tr } from '../../../shared/i18n';

/** Event (on ctx.root) requesting an agent's card to appear: scroll into view and focus. */
export const PERMISSION_FOCUS_EVENT = 'habblaud:permission-focus';
const PREVIEW_LINES = 12;
const MESSAGE_MAX = 1_000;

const DESTINATIONS: Record<string, string> = {
  session: tr('this session only'),
  localSettings: tr('in this project, just for you'),
  projectSettings: tr('in this project, for everyone (versioned)'),
  userSettings: tr('in all projects'),
};

/** Where the "always allow" rule is stored, labeled for UI. */
export function destinationLabel(destination: string): string {
  return DESTINATIONS[destination] ?? destination;
}

/**
 * "returns to the terminal in 4 min" (when the hook gives up waiting). `seconds` counts seconds in the last minute
 * (Codex timeout is in seconds).
 */
export function expiryText(expiresAt: number, now: number, seconds = false): string {
  const left = expiresAt - now;
  if (left <= 0) return tr('returning to the terminal…');
  if (left < 60_000) return seconds ? tr('returns to the terminal in {0} s', [Math.ceil(left / 1_000)]) : tr('returns to the terminal in under 1 min');
  return tr('returns to the terminal in {0}', [formatDuration(left)]);
}

/** Warning on the card for a Codex request. */
export const CODEX_PERMISSION_NOTE = tr('In Codex, the approval only shows up in the terminal after you answer here or the time runs out.');

/** What the card offers for a request (varies by tool). */
export interface PermissionOptions {
  /** "Approve and don't ask again" (Claude Code suggestions). */
  always: boolean;
  /** "Interrupt the agent" alongside denying. */
  interrupt: boolean;
  /** Deny only with a reason. */
  reasonRequired: boolean;
  /** Timeout counted in seconds during the last minute. */
  seconds: boolean;
  /** Short note below preview ('' = none). */
  note: string;
}

export function permissionOptions(p: Pick<PermissionRequestInfo, 'provider' | 'suggestions'>, agent: Pick<AgentInfo, 'kind' | 'background'>): PermissionOptions {
  if (p.provider === 'codex') return { always: false, interrupt: false, reasonRequired: true, seconds: true, note: CODEX_PERMISSION_NOTE };
  // Background subagent: Claude Code only displays the dialog after the hook responds.
  const blocking = agent.kind === 'sub' && !!agent.background;
  return {
    always: !!p.suggestions?.length,
    interrupt: true,
    reasonRequired: false,
    seconds: false,
    note: blocking ? tr('This subagent runs in the background: the terminal only shows the request after you answer here or choose “Answer in terminal”.') : '',
  };
}

/** Agents with requests to answer, from oldest to newest. */
export function permissionAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.permission && a.status !== 'offline' && a.status !== 'done').sort((a, b) => a.permission!.createdAt - b.permission!.createdAt);
}

/** Next agent with a request after `currentId` (loops back to first at queue end). */
export function nextPermissionAgent(agents: readonly AgentInfo[], currentId?: string): AgentInfo | undefined {
  const list = permissionAgents(agents);
  if (!list.length) return undefined;
  const i = currentId ? list.findIndex((a) => a.id === currentId) : -1;
  return list[(i + 1) % list.length];
}

/** Selects the agent and asks the card to appear (scroll into view and focus). */
export function focusPermission(ctx: UiContext, agentId: string): void {
  ctx.select({ type: 'agent', id: agentId }, { focus: true });
  ctx.root.dispatchEvent(new CustomEvent(PERMISSION_FOCUS_EVENT, { detail: agentId }));
}

/** Was the page opened on the local machine? (legacy rule; decided by server now, see net/access.ts) */
export const isLocalHostname = isLoopbackHostname;

/** Request answered by choosing (AskUserQuestion questions), not approving. Codex never asks questions. */
export function isQuestionRequest(p: Pick<PermissionRequestInfo, 'tool' | 'questions' | 'provider'> | undefined): boolean {
  return !!p && p.provider !== 'codex' && p.tool === ASK_TOOL && !!p.questions?.length;
}

/** Selected state for a question card: options (indices in original) and "Other" (checked and text). */
export interface AskChoice {
  options: readonly number[];
  otherOn: boolean;
  otherText: string;
}

/**
 * Answer for a question based on current selection; undefined = not yet answered. Single choice: option
 * OR "Other"; multiple choice: options and "Other" combined. "Other" checked without text counts as unanswered.
 */
export function answerFor(q: AskQuestion, c: AskChoice | undefined): PermissionAnswer | undefined {
  if (!c) return undefined;
  const other = c.otherOn ? c.otherText.trim().slice(0, ANSWER_OTHER_MAX) : '';
  if (c.otherOn && !other) return undefined;
  const options = q.multiSelect || !other ? c.options.filter((i) => q.options.some((o) => o.index === i)) : [];
  if (!options.length && !other) return undefined;
  return { question: q.index, ...(options.length ? { options: [...options] } : {}), ...(other ? { other } : {}) };
}

/**
 * Answer payload (`answers` in decision) when all questions are answered in a way accepted by
 * the server; undefined while any are missing (the Answer button stays disabled).
 */
export function buildAnswers(questions: readonly AskQuestion[], choices: ReadonlyMap<number, AskChoice>): PermissionAnswer[] | undefined {
  const answers: PermissionAnswer[] = [];
  for (const q of questions) {
    const a = answerFor(q, choices.get(q.index));
    if (!a) return undefined;
    answers.push(a);
  }
  return checkAnswers(questions, answers);
}

/** The full command goes into the "$ …" box (what gets approved); title only shows tool name. */
function commandPreview(p: Pick<PermissionRequestInfo, 'input' | 'inputKind'> | null): boolean {
  return !!p && p.inputKind === 'command' && !!p.input?.trim();
}

/** Arguments preview (command, diff, JSON, text), using the same classes as terminal. */
function previewBlock(p: Pick<PermissionRequestInfo, 'title' | 'input' | 'inputKind'>): HTMLElement | null {
  if (!commandPreview(p) && !showToolInput(p)) return null;
  const kind = p.inputKind ?? 'text';
  const text = p.input!.replace(/\s+$/, '');
  const fill = (target: HTMLElement, value: string) => {
    target.replaceChildren();
    if (kind !== 'diff') return void (target.textContent = value);
    for (const line of value.split('\n')) target.append(h('span', { class: `ui-term__dl is-${diffLineKind(line)}`, text: line || ' ' }));
  };
  const pv = previewText(text, PREVIEW_LINES);
  const body = h('div', { class: 'ui-term__pre' });
  fill(body, pv.head);
  const box = h('div', { class: `ui-term__in ui-term__in--${kind}` }, body);
  if (kind === 'command') box.prepend(h('span', { class: 'ui-term__dollar', text: '$', attrs: { 'aria-hidden': 'true' } }));
  if (pv.collapsed) {
    let open = false;
    const more = h('button', { class: 'ui-term__more', type: 'button', text: moreLabel(pv.hiddenLines), attrs: { 'aria-expanded': 'false' } });
    more.addEventListener('click', () => {
      open = !open;
      fill(body, open ? pv.text : pv.head);
      setText(more, open ? tr('collapse') : moreLabel(pv.hiddenLines));
      setAttr(more, 'aria-expanded', String(open));
    });
    box.append(more);
  }
  return box;
}

type Phase = 'idle' | 'deny' | 'sending' | 'sent';

/** An AskUserQuestion question in the card: option checkboxes/radios and "Other" (checkbox/radio and text). */
interface AskRefs {
  q: AskQuestion;
  el: HTMLElement;
  options: HTMLInputElement[];
  other: HTMLInputElement;
  text: HTMLInputElement;
}

const DONE: Record<PermissionDecision['behavior'], string> = { allow: tr('Approved'), deny: tr('Denied'), answer: tr('Answered'), terminal: tr('Sent back to the terminal') };

/**
 * "Asks for permission" (or "Questions for you", in AskUserQuestion) card in the agent drawer. Disappears when the
 * request is answered (here or in the terminal), expires, or the agent leaves.
 */
export class PermissionCard {
  readonly el: HTMLElement;
  private id = '';
  private agentId = '';
  private phase: Phase = 'idle';
  private detailReq = 0;
  private detail: PermissionRequestInfo | null = null;
  private pendingFocus: string | null = null;

  private icon: HTMLElement;
  private title: HTMLElement;
  private what: HTMLElement;
  private timer: HTMLElement;
  private tool: HTMLElement;
  private preview: HTMLElement;
  private note: HTMLElement;
  private queue: HTMLElement;
  private approveBtn: HTMLButtonElement;
  private denyBtn: HTMLButtonElement;
  private terminalBtn: HTMLButtonElement;
  private always: HTMLElement;
  private suggestions: KeyedList<PermissionSuggestionInfo, HTMLButtonElement>;
  private denyForm: HTMLFormElement;
  private reason: HTMLTextAreaElement;
  private interrupt: HTMLInputElement;
  private interruptRow: HTMLElement;
  private denySubmit: HTMLButtonElement;
  /** What the card offers for current request (Claude Code or Codex). */
  private opts: PermissionOptions = { always: false, interrupt: true, reasonRequired: false, seconds: false, note: '' };
  private status: HTMLElement;
  private remote: HTMLElement;
  /** AskUserQuestion questions, built once per request (selection survives snapshots). */
  private askForm: HTMLFormElement;
  private askId = '';
  private askRefs: AskRefs[] = [];
  private answerBtn: HTMLButtonElement;

  constructor(private ctx: UiContext) {
    this.icon = h('span', { class: 'ui-perm__icon', attrs: { 'aria-hidden': 'true' } });
    this.title = h('strong', { class: 'ui-perm__title' });
    this.what = h('p', { class: 'ui-perm__what' });
    this.timer = h('span', { class: 'ui-perm__timer' });
    this.tool = h('div', { class: 'ui-perm__tool' });
    this.preview = h('div', { class: 'ui-perm__preview' });
    this.note = h('p', { class: 'ui-perm__note', hidden: true });
    this.queue = h('p', { class: 'ui-perm__queue', hidden: true });
    this.remote = h('p', { class: 'ui-perm__note', hidden: true, text: tr('To answer from here, open Habblaud at http://localhost (or 127.0.0.1). For now, answer in the terminal.') });

    this.approveBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => this.send({ behavior: 'allow' }) } }, tr('✓ Approve'));
    this.answerBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', hidden: true, on: { click: () => this.sendAnswer() } }, tr('✓ Answer'));
    this.askForm = h('form', { class: 'ui-perm-ask', hidden: true, attrs: { 'aria-label': tr("Agent's questions") } });
    this.askForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendAnswer();
    });
    this.askForm.addEventListener('change', () => this.syncAnswer());
    this.denyBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--deny', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => this.toggleDeny() } }, tr('✕ Deny…'));
    this.terminalBtn = h(
      'button',
      { class: 'ui-btn ui-perm__btn', type: 'button', title: tr('Habblaud sets this request aside: your answer in the terminal is what counts'), on: { click: () => this.send({ behavior: 'terminal' }) } },
      tr('Answer in terminal'),
    );

    const list = h('div', { class: 'ui-perm__rules' });
    this.suggestions = new KeyedList<PermissionSuggestionInfo, HTMLButtonElement>(list, {
      animate: false,
      key: (s) => String(s.index),
      create: (s) => h('button', { class: 'ui-btn ui-perm__rule', type: 'button', on: { click: () => this.send({ behavior: 'allow', suggestion: s.index }) } }),
      update: (btn, s) => {
        const rules = s.rules.join(', ');
        setText(btn, `${rules} · ${destinationLabel(s.destination)}`);
        setTitle(btn, tr("Approve now and don't ask again: {0} ({1})", [rules, destinationLabel(s.destination)]));
      },
    });
    this.always = h('div', { class: 'ui-perm__always', hidden: true }, h('span', { class: 'ui-perm__always-label', text: tr("Approve and don't ask again:") }), list);

    this.reason = h('textarea', { class: 'ui-perm__reason', attrs: { rows: 2, maxlength: MESSAGE_MAX, placeholder: tr('Reason (optional, goes to the agent). E.g.: use pnpm instead of npm'), 'aria-label': tr('Reason for denying (optional)') } });
    this.interrupt = h('input', { type: 'checkbox', class: 'ui-perm__check' });
    this.interruptRow = h('label', { class: 'ui-perm__check-row' }, this.interrupt, h('span', { text: tr('Interrupt the agent (it stops and waits for you)') }));
    this.denySubmit = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--deny', type: 'submit' }, tr('Deny'));
    this.denyForm = h(
      'form',
      { class: 'ui-perm__deny', hidden: true },
      this.reason,
      this.interruptRow,
      h('div', { class: 'ui-perm__actions' }, this.denySubmit, h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => this.toggleDeny(false) } }, tr('Cancel'))),
    );
    // Codex: deny only with a reason (button enables when text is present).
    this.reason.addEventListener('input', () => this.syncDeny());
    this.denyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = this.reason.value.trim().slice(0, MESSAGE_MAX);
      if (this.opts.reasonRequired && !message) return this.reason.focus();
      this.send({ behavior: 'deny', ...(message ? { message } : {}), ...(this.opts.interrupt && this.interrupt.checked ? { interrupt: true } : {}) });
    });
    // Escape inside the form closes only the form (not the drawer).
    this.denyForm.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.toggleDeny(false);
    });

    this.status = h('p', { class: 'ui-perm__status', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'section',
      { class: 'ui-perm', hidden: true, tabIndex: -1 },
      h('div', { class: 'ui-perm__head' }, this.icon, h('div', { class: 'ui-perm__head-text' }, this.title, this.what), this.timer),
      this.tool,
      this.preview,
      this.askForm,
      this.note,
      this.queue,
      this.remote,
      h('div', { class: 'ui-perm__actions' }, this.approveBtn, this.answerBtn, this.denyBtn, this.terminalBtn),
      this.always,
      this.denyForm,
      this.status,
    );
    ctx.root.addEventListener(PERMISSION_FOCUS_EVENT, (e) => {
      this.pendingFocus = (e as CustomEvent<string>).detail;
      ctx.invalidate();
    });
  }

  /** The card is visible (there is a request for this agent). */
  get visible(): boolean {
    return !this.el.hidden;
  }

  render(agent: AgentInfo | undefined): void {
    const p = agent?.permission;
    if (!agent || !p) {
      setHidden(this.el, true);
      this.reset('', agent?.id ?? '');
      return;
    }
    if (p.id !== this.id || agent.id !== this.agentId) this.reset(p.id, agent.id);
    setHidden(this.el, false);
    const now = this.ctx.now();
    const opts = (this.opts = permissionOptions(p, agent));
    const codex = p.provider === 'codex';
    this.el.classList.toggle('is-codex', codex);
    const ask = isQuestionRequest(p);
    const kind = ask ? 'ask' : 'perm';
    if (this.el.dataset.kind !== kind) {
      this.el.dataset.kind = kind;
      this.icon.innerHTML = ask ? ICONS.help : ICONS.lock;
      setAttr(this.el, 'aria-label', ask ? tr("Agent's question") : tr('Permission request'));
    }
    setText(this.title, ask ? (p.questions!.length > 1 ? tr('Questions for you') : tr('Question for you')) : tr('Asks for permission'));
    const by = p.subagent ? tr(' · subagent {0}', [p.subagent]) : '';
    setText(this.what, ask ? tr('Here or in the terminal: the first answer wins{0}', [by]) : `${p.icon} ${p.text}${by}`);
    setText(this.timer, expiryText(p.expiresAt, now, opts.seconds));
    setTitle(
      this.timer,
      codex
        ? tr("Requested at {0}. With no answer here by {1}, Codex moves on without the office's decision and asks for approval in the terminal.", [formatClock(p.createdAt), formatClock(p.expiresAt)])
        : tr('Requested at {0}. With no answer here by {1}, Habblaud hands the request back to the terminal.', [formatClock(p.createdAt), formatClock(p.expiresAt)]),
    );

    // Question: form with options instead of tool title and arguments preview.
    setHidden(this.tool, ask);
    setHidden(this.preview, ask);
    setHidden(this.askForm, !ask);
    if (ask && this.askId !== p.id) this.buildAsk(p);
    if (!ask) {
      const full = this.detail?.id === p.id ? this.detail : p.input !== undefined ? p : null;
      const { name, args } = splitToolTitle(p.title);
      const shown = commandPreview(full) ? '' : args;
      if (this.tool.dataset.title !== `${p.title}|${shown}`) {
        this.tool.dataset.title = `${p.title}|${shown}`;
        this.tool.replaceChildren(h('strong', { text: name }), shown ? document.createTextNode(shown) : '');
      }
      setTitle(this.tool, p.title);
      if (this.preview.dataset.id !== `${p.id}:${full ? 'full' : 'short'}`) {
        this.preview.dataset.id = `${p.id}:${full ? 'full' : 'short'}`;
        this.preview.replaceChildren(full ? (previewBlock(full) ?? '') : h('span', { class: 'ui-muted ui-small', text: tr('Loading details…') }));
      }
    }

    // Warning: background subagent (Claude Code) or Codex terminal, which only prompts after office.
    setHidden(this.note, !opts.note);
    setText(this.note, opts.note);
    setHidden(this.queue, !p.queued);
    setText(this.queue, p.queued ? tr('+{0} {1} from this agent in the queue', [p.queued, p.queued === 1 ? tr('request') : tr('requests')]) : '');

    setHidden(this.remote, this.isLocal());
    const busy = this.isBusy();
    setHidden(this.approveBtn, ask);
    setHidden(this.answerBtn, !ask);
    for (const b of [this.approveBtn, this.denyBtn, this.terminalBtn]) b.disabled = busy;
    for (const el of this.askForm.querySelectorAll('input')) el.disabled = busy;
    if (ask) this.syncAnswer();
    setTitle(this.denyBtn, ask ? tr("Don't answer: the agent continues without the answer (with the reason, if you write one)") : codex ? tr('Deny with a reason (Codex requires one)') : '');
    setTitle(
      this.terminalBtn,
      codex ? tr('Habblaud releases the request now: Codex shows the approval in the terminal') : tr('Habblaud sets this request aside: your answer in the terminal is what counts'),
    );
    this.suggestions.sync(opts.always ? (p.suggestions ?? []) : []);
    for (const b of this.suggestions.container.querySelectorAll('button')) b.disabled = busy;
    setHidden(this.always, ask || !opts.always || this.phase === 'deny');
    setHidden(this.denyForm, this.phase !== 'deny');
    setHidden(this.interruptRow, !opts.interrupt);
    setAttr(
      this.reason,
      'placeholder',
      opts.reasonRequired
        ? tr('Reason (required in Codex, goes to the agent). E.g.: use pnpm instead of npm')
        : tr('Reason (optional, goes to the agent). E.g.: {0}', [ask ? tr('you decide, going with the safest option') : tr('use pnpm instead of npm')]),
    );
    setAttr(this.reason, 'aria-label', opts.reasonRequired ? tr('Reason for denying (required)') : tr('Reason for denying (optional)'));
    for (const el of this.denyForm.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>('button, textarea, input')) el.disabled = busy;
    this.syncDeny();
    setAttr(this.denyBtn, 'aria-expanded', String(this.phase === 'deny'));
    this.denyBtn.classList.toggle('is-on', this.phase === 'deny');

    if (this.pendingFocus === agent.id) {
      this.pendingFocus = null;
      requestAnimationFrame(() => {
        this.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        this.el.focus({ preventScroll: true });
      });
    }
  }

  private reset(id: string, agentId: string): void {
    if (id === this.id && agentId === this.agentId) return;
    this.id = id;
    this.agentId = agentId;
    this.phase = 'idle';
    this.detail = null;
    this.reason.value = '';
    this.interrupt.checked = false;
    setText(this.status, '');
    this.status.classList.remove('is-error');
    delete this.preview.dataset.id;
    this.askId = '';
    this.askRefs = [];
    this.askForm.replaceChildren();
    if (!id) return;
    const req = ++this.detailReq;
    this.ctx.store
      .permissionDetail(agentId, id)
      .then((d) => {
        if (req !== this.detailReq || !d) return;
        this.detail = d;
        this.ctx.invalidate();
      })
      .catch(() => {
        // Without details (non-local access or already answered request): keep the title.
      });
  }

  /** Codex: "Deny" only enables with a written reason. */
  private syncDeny(): void {
    const missing = this.opts.reasonRequired && !this.reason.value.trim();
    this.denySubmit.disabled = this.isBusy() || missing;
    setTitle(this.denySubmit, missing ? tr('Write the reason: Codex only denies with a reason') : '');
  }

  private toggleDeny(open = this.phase !== 'deny'): void {
    if (this.phase === 'sending' || this.phase === 'sent') return;
    this.phase = open ? 'deny' : 'idle';
    this.ctx.invalidate();
    if (open) requestAnimationFrame(() => this.reason.focus());
    else this.denyBtn.focus();
  }

  private async send(d: PermissionDecision): Promise<void> {
    const id = this.id;
    if (!id || this.phase === 'sending' || this.phase === 'sent') return;
    this.phase = 'sending';
    this.status.classList.remove('is-error');
    setText(this.status, tr('Sending the answer…'));
    this.ctx.invalidate();
    let error: string | undefined;
    try {
      error = await this.ctx.store.decidePermission(id, d);
    } catch {
      error = tr("Couldn't reach Habblaud. Answer in the terminal.");
    }
    if (this.id !== id) return;
    if (error) {
      this.phase = 'idle';
      this.status.classList.add('is-error');
      setText(this.status, error);
    } else {
      this.phase = 'sent';
      const done = DONE[d.behavior];
      setText(this.status, `${done}.`);
      this.ctx.announce(`${done}: ${this.ctx.agent(this.agentId)?.name ?? tr('agent')}.`);
    }
    this.ctx.invalidate();
  }

  /** This page can respond (local port, or remote with permissions allowed; or mock mode). */
  private isLocal(): boolean {
    return this.ctx.store.mock || access().permissions;
  }

  /** Unable to answer right now: sending, already answered, or page opened remotely. */
  private isBusy(): boolean {
    return this.phase === 'sending' || this.phase === 'sent' || !this.isLocal();
  }

  // ---------------------------------------------------------------- questions (AskUserQuestion)

  /** Builds questions for a request (only when request changes: selection survives snapshots). */
  private buildAsk(p: PermissionRequestInfo): void {
    this.askId = p.id;
    this.askRefs = (p.questions ?? []).map((q) => this.askQuestion(p.id, q));
    this.askForm.replaceChildren(...this.askRefs.map((r) => r.el));
  }

  /** One question: radios (single choice) or checkboxes (multiple), each option with description, and "Other" with text. */
  private askQuestion(requestId: string, q: AskQuestion): AskRefs {
    const name = `ask-${requestId}-${q.index}`;
    const input = (value: string) => h('input', { class: 'ui-perm-ask__input', type: q.multiSelect ? 'checkbox' : 'radio', attrs: { name, value } });
    const optionText = (label: string, description?: string) =>
      h('span', { class: 'ui-perm-ask__opt-text' }, h('strong', { text: label }), description ? h('span', { class: 'ui-ask__desc', text: description }) : null);
    const options = q.options.map((o) => ({ input: input(String(o.index)), o }));
    const other = input('other');
    const text = h('input', {
      class: 'ui-perm-ask__text',
      type: 'text',
      attrs: { maxlength: ANSWER_OTHER_MAX, placeholder: tr('Write your answer'), autocomplete: 'off', 'aria-label': tr('Other answer for: {0}', [q.question]) },
    });
    text.addEventListener('input', () => {
      // Typing in the input checks "Other".
      if (text.value.trim() && !other.checked) other.checked = true;
      this.syncAnswer();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.sendAnswer();
      } else if (e.key === 'Escape') {
        // Escape blurs the input (does not close drawer).
        e.preventDefault();
        text.blur();
      }
    });
    const el = h(
      'fieldset',
      { class: 'ui-perm-ask__q' },
      h('legend', { class: 'ui-perm-ask__legend' }, q.header ? h('span', { class: 'ui-ask__tag', text: q.header }) : null, h('span', { class: 'ui-ask__question', text: q.question })),
      h('p', { class: 'ui-ask__hint', text: q.multiSelect ? tr('You can pick more than one') : tr('Pick one') }),
      ...options.map(({ input: box, o }) => h('label', { class: 'ui-perm-ask__opt' }, box, optionText(o.label, o.description))),
      h('div', { class: 'ui-perm-ask__other' }, h('label', { class: 'ui-perm-ask__opt' }, other, optionText(tr('Other'))), text),
    );
    return { q, el, options: options.map((x) => x.input), other, text };
  }

  /** Current selection in each question. */
  private choices(): Map<number, AskChoice> {
    return new Map(this.askRefs.map((r) => [r.q.index, { options: r.options.filter((i) => i.checked).map((i) => Number(i.value)), otherOn: r.other.checked, otherText: r.text.value }]));
  }

  private answers(): PermissionAnswer[] | undefined {
    return buildAnswers(
      this.askRefs.map((r) => r.q),
      this.choices(),
    );
  }

  /** Enables Answer only when all questions are answered. */
  private syncAnswer(): void {
    const ready = !!this.answers();
    this.answerBtn.disabled = this.isBusy() || !ready;
    setTitle(this.answerBtn, ready ? tr('Send the answers to the agent') : tr('Answer all the questions (for “Other”, write the answer)'));
  }

  private sendAnswer(): void {
    const answers = this.answers();
    if (answers && !this.isBusy()) void this.send({ behavior: 'answer', answers });
  }
}
