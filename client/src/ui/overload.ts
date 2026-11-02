// "Boss overloaded" (toolbar button, shortcut H): Claude Code sessions whose context is getting full or that were
// compacted (shared/overload.ts), the boss first. Long sessions get slow and forgetful, so the dialog suggests the
// usual way out: ask the session to update the project's handoff file (through habblaud-mensagens, when the session
// takes messages), then open a new session in the same folder, which reads the handoff and carries on.
import type { AgentInfo, OfficeInfo, OfficeSnapshot } from '../../../shared/types';
import { sessionLoad, type LoadLevel, type LoadThresholds, type SessionLoad } from '../../../shared/overload';
import type { TerminalRouter, UiContext } from './context';
import { h, iconButton, setHidden, setText, setVariant } from './dom';
import { formatDuration } from './format';
import { ICONS } from './icons';
import type { PageNotice } from './toasts';
import { agentOfficeId, teamOffices } from './offices';
import { tr } from '../../../shared/i18n';

export interface LoadedSession {
  agent: AgentInfo;
  load: SessionLoad;
}

const RANK: Record<LoadLevel, number> = { overloaded: 2, tired: 1, ok: 0 };

/** Tired or overloaded Claude Code main sessions: the boss first, then the most loaded. */
export function loadedSessions(agents: readonly AgentInfo[], thresholds?: LoadThresholds): LoadedSession[] {
  return agents
    .filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude')
    .map((agent) => ({ agent, load: sessionLoad(agent, thresholds) }))
    .filter((s) => s.load.level !== 'ok')
    .sort((a, b) => Number(!!b.agent.boss) - Number(!!a.agent.boss) || RANK[b.load.level] - RANK[a.load.level] || (b.load.share ?? 0) - (a.load.share ?? 0));
}

/** The office's own sessions (its building); everyone with a single office or none shown. */
export function officeSessions(sessions: readonly LoadedSession[], snap: Pick<OfficeSnapshot, 'agents' | 'team'> | null | undefined, office: OfficeInfo | undefined): LoadedSession[] {
  const offices = teamOffices(snap?.team);
  return office && offices.length > 1 ? sessions.filter((s) => agentOfficeId(snap, s.agent, offices) === office.id) : [...sessions];
}

/** Sessions whose level rose past what you were told; `told` keeps the highest level until the session is fine again. */
export function risenLoads(sessions: readonly LoadedSession[], told: Map<string, LoadLevel>): LoadedSession[] {
  const risen = sessions.filter((s) => RANK[s.load.level] > RANK[told.get(s.agent.id) ?? 'ok']);
  for (const id of [...told.keys()]) if (!sessions.some((s) => s.agent.id === id)) told.delete(id);
  for (const s of risen) told.set(s.agent.id, s.load.level);
  return risen;
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
  private titleEl!: HTMLElement;
  private sig = '';
  private sent = new Set<string>();
  /** Bosses you were warned about, and at what level. */
  private readonly told = new Map<string, LoadLevel>();

  constructor(
    private ctx: UiContext,
    private toast: (n: PageNotice) => void,
  ) {
    this.button = h('button', { class: 'ui-icon-btn ui-btn-overload', type: 'button', text: '🥵', on: { click: () => this.toggle() }, attrs: { 'aria-haspopup': 'dialog' } });
    this.button.hidden = true;
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.list = h('ol', { class: 'ui-overload__list' });
    this.status = h('p', { class: 'ui-overload__status ui-muted', role: 'status' });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-overload', attrs: { 'aria-labelledby': 'ui-overload-title' } },
      h('div', { class: 'ui-dialog__head' }, (this.titleEl = h('h2', { attrs: { id: 'ui-overload-title' }, text: tr('🥵 Boss overloaded') })), close),
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
    else if (this.sessions().length) this.open();
    else this.ctx.announce(tr('No session is overloaded right now.'));
  }

  private sessions(): LoadedSession[] {
    const snap = this.ctx.store.snapshot;
    return officeSessions(loadedSessions(snap?.agents ?? [], this.ctx.prefs.overload), snap, this.ctx.selectedOffice());
  }

  /** A boss past a threshold, in any office: a notice right away, once per level. The boss itself is not told. */
  private warn(): void {
    const snap = this.ctx.store.snapshot;
    if (!snap || this.ctx.store.mock) return;
    const offices = teamOffices(snap.team);
    const bosses = loadedSessions(snap.agents, this.ctx.prefs.overload).filter((s) => s.agent.boss);
    for (const { agent, load } of risenLoads(bosses, this.told)) {
      const officeId = agentOfficeId(snap, agent, offices);
      const office = offices.find((o) => o.id === officeId);
      const who = office && offices.length > 1 ? `${agent.name} · ${office.name}` : agent.name;
      const facts = this.facts(load).join(', ');
      const text = load.level === 'overloaded' ? tr('😵 {0} is overloaded ({1}). Save the work to the HANDOFF file and start a new session.', [who, facts]) : tr('🥵 {0} is getting tired ({1}). Save the work to the HANDOFF file and start a new session.', [who, facts]);
      this.toast({
        id: `overload:${agent.id}:${load.level}`,
        level: 'warn',
        text,
        agentId: agent.id,
        at: this.ctx.now(),
        sticky: load.level === 'overloaded',
        open: () => {
          if (officeId) this.ctx.selectOffice(officeId);
          this.open();
        },
      });
    }
  }

  private facts(load: SessionLoad): string[] {
    return [load.share !== undefined ? tr('context {0}%', [Math.round(load.share * 100)]) : '', load.compacts ? tr('compacted {0}×', [load.compacts]) : ''].filter(Boolean);
  }

  render(): void {
    this.warn();
    const sessions = this.sessions();
    this.renderButton(sessions);
    if (!this.el.open) return;
    const office = this.ctx.selectedOffice();
    setText(this.titleEl, office && teamOffices(this.ctx.store.snapshot?.team).length > 1 ? tr('🥵 Boss overloaded · {0}', [office.name]) : tr('🥵 Boss overloaded'));
    const now = this.ctx.now();
    const sig = JSON.stringify([sessions.map((s) => [s.agent.id, s.agent.name, s.agent.canMessage, s.load]), [...this.sent], Math.floor(now / 60_000)]);
    if (sig === this.sig) return;
    this.sig = sig;
    const term = this.ctx.terminals;
    const pty = !!term?.interactiveEnabled;
    this.list.replaceChildren(
      ...sessions.map(({ agent, load }) => {
        const room = this.ctx.store.snapshot?.rooms.find((r) => r.id === agent.roomId);
        const facts = [...this.facts(load), tr('open for {0}', [formatDuration(now - agent.startedAt)])];
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
