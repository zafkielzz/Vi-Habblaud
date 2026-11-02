// Terminal window tabs: main agents present in the same project (room) as the open agent.
// Clicking a tab switches the window to that agent's terminal (interactive or live). Dragging a tab
// changes the order (the same as the sidebar list; see ui/agentorder.ts). Next to the name, the start of what the
// agent is doing; the X ends the session (requires a second click) and only appears with interactive terminal on.
import type { AgentInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { moveAgent, orderAgents } from './agentorder';
import { h, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { activityFallback } from './model';
import { ptyControllable, stopAgent } from './ptyapi';
import { createStatusDot, updateStatusDot } from './widgets';
import { sessionAgents } from './workers-api';
import { tr } from '../../../shared/i18n';

/** How long the X stays requesting confirmation. */
const CONFIRM_MS = 3000;

/** What to show next to the name: activity of working or waiting agents; conversation title of idle agents. */
function doingOf(a: AgentInfo): string {
  if (a.status === 'working' || a.status === 'waiting') return a.activity?.text ?? activityFallback(a);
  return a.title ?? '';
}

export class TermTabs {
  readonly el: HTMLElement;
  private list: KeyedList<AgentInfo>;
  private current: string | null = null;
  private roomId: string | null = null;
  private peers: AgentInfo[] = [];
  /** Tab whose X is waiting for the second click. */
  private confirming: string | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tab being dragged (agent id). */
  private dragging: string | null = null;

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-ttabs', role: 'tablist', hidden: true, attrs: { 'aria-label': tr('Project agents (drag to reorder)') } });
    this.list = new KeyedList<AgentInfo>(this.el, {
      animate: false,
      key: (a) => a.id,
      create: (a) => {
        const b = h(
          'button',
          { class: 'ui-ttab', type: 'button', role: 'tab', attrs: { draggable: 'true' } },
          createStatusDot(),
          h('span', { class: 'ui-ttab__name' }),
          h('span', { class: 'ui-ttab__doing' }),
          h('span', { class: 'ui-ttab__live', text: '›_', hidden: true }),
          // Inside the tab button: span (button inside button is invalid); keyboard uses Delete on the tab.
          h('span', { class: 'ui-ttab__close', role: 'button', attrs: { 'aria-label': tr('End this session') }, text: '×' }),
        );
        const close = b.children[4] as HTMLElement;
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeTab(b.dataset.id!);
        });
        close.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('keydown', (e) => {
          if (e.key === 'Delete') {
            e.preventDefault();
            this.closeTab(b.dataset.id!);
          }
        });
        b.dataset.id = a.id;
        b.addEventListener('click', () => {
          const id = b.dataset.id!;
          if (id !== this.current) ctx.terminals?.open(id);
        });
        this.wireDrag(b);
        return b;
      },
      update: (b, a) => {
        b.dataset.id = a.id;
        updateStatusDot(b.firstElementChild as HTMLElement, a.status);
        setText(b.children[1] as HTMLElement, a.name);
        const doing = doingOf(a);
        setText(b.children[2] as HTMLElement, doing);
        setHidden(b.children[2] as HTMLElement, !doing);
        const live = !!ctx.terminals?.interactive(a.id);
        setHidden(b.children[3] as HTMLElement, !live);
        const close = b.children[4] as HTMLElement;
        const confirm = this.confirming === a.id;
        setHidden(close, !ctx.terminals?.interactiveEnabled || !ptyControllable(a));
        close.classList.toggle('is-confirm', confirm);
        setText(close, confirm ? tr('end?') : '×');
        setTitle(close, confirm ? tr('Click again to end the session (the conversation is saved)') : tr('End this session'));
        const on = a.id === this.current;
        b.classList.toggle('is-on', on);
        setAttr(b, 'aria-selected', String(on));
        setTitle(b, `${a.name}${a.title ? ` · ${a.title}` : ''}${doing && doing !== a.title ? `
${doing}` : ''}${live ? tr(' (interactive)') : ''}`);
      },
    });
  }

  /** `agentId` = open agent in window (null = history session or none). */
  render(agentId: string | null): void {
    this.current = agentId;
    const agent = agentId ? this.ctx.agent(agentId) : undefined;
    this.roomId = agent?.roomId ?? null;
    const snap = this.ctx.store.snapshot;
    // Antigravity characters and workers have a terminal only while one runs here (else the tab leads nowhere).
    const running = new Set((snap?.ptys ?? []).filter((p) => p.exitedAt === undefined).map((p) => p.agentId));
    const workers = new Set((snap?.team?.sessions ?? []).flatMap((s) => sessionAgents(s)));
    const hasTerminal = (a: AgentInfo) => running.has(a.id) || ((a.provider ?? 'claude') !== 'agy' && !workers.has(a.id));
    const peers = agent
      ? (snap?.agents ?? [])
          .filter((a) => a.kind === 'main' && a.roomId === agent.roomId && a.status !== 'offline' && !a.id.startsWith('demo:') && (a.id === agent.id || hasTerminal(a)))
          .sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
      : [];
    this.peers = agent ? orderAgents(agent.roomId, peers, (a) => a.sessionId) : [];
    // A single tab is not helpful: hide it.
    setHidden(this.el, this.peers.length < 2);
    this.list.sync(this.peers.length < 2 ? [] : this.peers);
  }

  /** Tab X: first click requests confirmation; second ends session (here or in another terminal). */
  private closeTab(id: string): void {
    if (!this.ctx.terminals?.interactiveEnabled || !ptyControllable(this.ctx.agent(id))) return;
    if (this.confirming !== id) {
      this.resetConfirm();
      this.confirming = id;
      this.confirmTimer = setTimeout(() => {
        this.resetConfirm();
        this.ctx.invalidate();
      }, CONFIRM_MS);
      this.ctx.invalidate();
      return;
    }
    this.resetConfirm();
    const name = this.ctx.agent(id)?.name ?? tr('Session');
    stopAgent(id)
      .then(() => this.ctx.announce(tr('{0}: session ended.', [name])))
      .catch((err: Error) => this.ctx.announce(tr("Couldn't end it: {0}", [err.message])))
      .finally(() => this.ctx.invalidate());
    // Was the open tab: switch to neighbor.
    if (id === this.current) {
      const i = this.peers.findIndex((a) => a.id === id);
      const next = this.peers[i + 1] ?? this.peers[i - 1];
      if (next) this.ctx.terminals?.open(next.id);
    }
  }

  private resetConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.confirming = null;
  }

  private wireDrag(b: HTMLElement): void {
    b.addEventListener('dragstart', (e) => {
      this.dragging = b.dataset.id ?? null;
      b.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.dragging ?? '');
      }
    });
    b.addEventListener('dragend', () => {
      this.dragging = null;
      b.classList.remove('is-dragging');
      this.clearMarks();
    });
    b.addEventListener('dragover', (e) => {
      if (!this.dragging || this.dragging === b.dataset.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = this.isAfter(b, e.clientX);
      this.clearMarks();
      b.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });
    b.addEventListener('dragleave', () => b.classList.remove('is-drop-before', 'is-drop-after'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragging;
      const to = b.dataset.id;
      this.clearMarks();
      if (!from || !to || from === to) return;
      this.move(from, to, this.isAfter(b, e.clientX));
    });
  }

  private isAfter(b: HTMLElement, x: number): boolean {
    const r = b.getBoundingClientRect();
    return x > r.left + r.width / 2;
  }

  private clearMarks(): void {
    for (const el of this.el.querySelectorAll('.is-drop-before, .is-drop-after')) el.classList.remove('is-drop-before', 'is-drop-after');
  }

  /** Places `from` before (or after) `to` and stores the project order. */
  private move(from: string, to: string, after: boolean): void {
    if (!this.roomId) return;
    if (moveAgent(this.roomId, this.peers, (a) => a.id, (a) => a.sessionId, from, to, after)) this.ctx.invalidate();
  }
}
