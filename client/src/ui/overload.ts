// "Boss overloaded" (toolbar button, shortcut H): Claude Code sessions whose context is getting full or that were
// compacted (shared/overload.ts), the boss first. Long sessions get slow and forgetful, so the dialog suggests the
// usual way out: ask the session to update the project's handoff file (through habblaud-mensagens, when the session
// takes messages), then open a new session in the same folder, which reads the handoff and carries on.
import type { AgentInfo } from '../../../shared/types';
import { sessionLoad, type LoadLevel, type SessionLoad } from '../../../shared/overload';
import type { TerminalRouter, UiContext } from './context';
import { h, iconButton, setHidden, setText, setVariant } from './dom';
import { formatDuration } from './format';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

export interface LoadedSession {
  agent: AgentInfo;
  load: SessionLoad;
}

const RANK: Record<LoadLevel, number> = { overloaded: 2, tired: 1, ok: 0 };

/** Tired or overloaded Claude Code main sessions: the boss first, then the most loaded. */
export function loadedSessions(agents: readonly AgentInfo[]): LoadedSession[] {
  return agents
    .filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude')
    .map((agent) => ({ agent, load: sessionLoad(agent) }))
    .filter((s) => s.load.level !== 'ok')
    .sort((a, b) => Number(!!b.agent.boss) - Number(!!a.agent.boss) || RANK[b.load.level] - RANK[a.load.level] || (b.load.share ?? 0) - (a.load.share ?? 0));
}

/** The text sent to the session when you ask for a handoff. */
export function handoffRequest(): string {
  return tr(
    'Your context is getting long. Update the handoff file of this project (HANDOFF*.md; create it if there is none): what is done, what is in progress, the next steps and anything a new session must know. Then tell me it is ready, and I will continue in a new session.',
  );
}

export class OverloadDialog {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private sig = '';
  private sent = new Set<string>();

  constructor(private ctx: UiContext) {
    this.button = h('button', { class: 'ui-icon-btn ui-btn-overload', type: 'button', text: '🥵', on: { click: () => this.toggle() }, attrs: { 'aria-haspopup': 'dialog' } });
    this.button.hidden = true;
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.list = h('ol', { class: 'ui-overload__list' });
    this.status = h('p', { class: 'ui-overload__status ui-muted', role: 'status' });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-overload', attrs: { 'aria-labelledby': 'ui-overload-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { attrs: { id: 'ui-overload-title' }, text: tr('🥵 Boss overloaded') }), close),
      h(
        'div',
        { class: 'ui-overload__body' },
        h('p', { text: tr('These sessions have a long context or were compacted: they get slower and forget earlier details. The usual way out: ask for a handoff, then continue in a new session in the same folder.') }),
        this.list,
        this.status,
      ),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    this.sig = '';
    setText(this.status, '');
    this.render();
    if (!this.el.open) this.el.showModal();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else if (loadedSessions(this.ctx.store.snapshot?.agents ?? []).length) this.open();
    else this.ctx.announce(tr('No session is overloaded right now.'));
  }

  render(): void {
    const sessions = loadedSessions(this.ctx.store.snapshot?.agents ?? []);
    this.renderButton(sessions);
    if (!this.el.open) return;
    const now = this.ctx.now();
    const sig = JSON.stringify([sessions.map((s) => [s.agent.id, s.agent.name, s.agent.canMessage, s.load]), [...this.sent], Math.floor(now / 60_000)]);
    if (sig === this.sig) return;
    this.sig = sig;
    const term = this.ctx.terminals;
    const pty = !!term?.interactiveEnabled;
    this.list.replaceChildren(
      ...sessions.map(({ agent, load }) => {
        const room = this.ctx.store.snapshot?.rooms.find((r) => r.id === agent.roomId);
        const facts = [
          load.share !== undefined ? tr('context {0}%', [Math.round(load.share * 100)]) : '',
          load.compacts ? tr('compacted {0}×', [load.compacts]) : '',
          tr('open for {0}', [formatDuration(now - agent.startedAt)]),
        ].filter(Boolean);
        const asked = this.sent.has(agent.id);
        const ask = h('button', {
          class: 'ui-btn',
          type: 'button',
          text: asked ? tr('✓ Handoff requested') : tr('✍️ Ask for a handoff'),
          attrs: { 'data-hint': tr('Asks this session to write down its progress in the HANDOFF file, so a new session can carry on.') },
          title: agent.canMessage ? handoffRequest() : tr('This session does not take messages from the office (habblaud-mensagens plugin).'),
          on: { click: () => void this.askHandoff(agent) },
        });
        ask.disabled = asked || !agent.canMessage;
        const fresh = h('button', {
          class: 'ui-btn',
          type: 'button',
          text: tr('➕ New session here'),
          title: room ? room.path : '',
          attrs: { 'data-hint': tr('Opens a new Claude Code in the same folder and account; the old session keeps running until you End it.') },
          on: { click: () => room && term && this.newSession(term, room.path, agent.account) },
        });
        fresh.disabled = !room || !pty;
        if (!pty) fresh.title = tr('Terminals in the browser are off; open a new session in a terminal: cd {0} && claude', [room?.path ?? '…']);
        return h(
          'li',
          { class: `ui-overload__item is-${load.level}` },
          h('div', { class: 'ui-overload__who' }, h('strong', { text: `${agent.boss ? '👑 ' : ''}${agent.name}` }), h('span', { class: 'ui-muted', text: room?.name ?? '' })),
          h('p', { class: 'ui-overload__facts', text: `${load.level === 'overloaded' ? tr('Overloaded') : tr('Tired')} · ${facts.join(' · ')}` }),
          h('div', { class: 'ui-overload__actions' }, ask, fresh),
        );
      }),
    );
  }

  private newSession(term: TerminalRouter, cwd: string, account: string): void {
    this.close();
    term.newSession(cwd, account).catch((err: Error) => this.ctx.announce(tr("Didn't work: {0}", [err.message])));
  }

  private async askHandoff(agent: AgentInfo): Promise<void> {
    setText(this.status, tr('Sending…'));
    try {
      const r = await this.ctx.store.sendMessage(agent.id, handoffRequest());
      if ('error' in r) {
        setText(this.status, tr('Not sent: {0}', [r.error]));
        return;
      }
      this.sent.add(agent.id);
      setText(this.status, tr('Sent to {0}. When the handoff is ready, open a new session in the same folder.', [agent.name]));
      this.sig = '';
      this.render();
    } catch {
      setText(this.status, tr('Not sent: no connection to Habblaud.'));
    }
  }

  private renderButton(sessions: LoadedSession[]): void {
    setHidden(this.button, !sessions.length);
    if (!sessions.length) return;
    const worst = sessions.some((s) => s.load.level === 'overloaded') ? 'overloaded' : 'tired';
    setVariant(this.button, 'is-', worst);
    const first = sessions[0];
    const label = tr('{0} is {1} (H)', [first.agent.name, worst === 'overloaded' ? tr('overloaded') : tr('tired')]);
    if (this.button.title !== label) {
      this.button.title = label;
      this.button.setAttribute('aria-label', label);
    }
  }
}
