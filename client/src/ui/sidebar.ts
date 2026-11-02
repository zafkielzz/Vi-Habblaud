// Sidebar: search and roles (the boss, the workers, others) -> agents -> subagents; the boss and the workers show their
// account's 5-hour and weekly quota.
// Grouped by role, not by folder: there is one boss (orchestrator) per office, whichever folder it works in; each row
// says where. With several offices the groups are those of the office shown (the office tabs): its boss and
// its workers; the other offices' bosses and workers sit in Others.
// Boss and Workers have a ＋ (ui/team-dialogs.ts); Others (sessions that are neither) is folded by default.
import type { AgentInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { moveAgent, orderAgents } from './agentorder';
import { h, iconButton, KeyedList, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { plural, usageLevel } from './format';
import { quotaWindows, type QuotaWindow } from './accounts';
import { ICONS } from './icons';
import { groupRoles, roleKey, roleScope, type AgentNode, type RoleGroup, type RoleKey, type RoleScope } from './model';
import { teamOffices } from './offices';
import { TeamDialogs } from './team-dialogs';
import { appointBoss, sessionOfAgent } from './workers-api';
import { officeIsEmpty } from './overlays';
import { createAgentRow, setAgentRowPlace, updateAgentRow } from './rows';
import { tr } from '../../../shared/i18n';

interface RoleRefs {
  head: HTMLElement;
  count: HTMLElement;
  /** "Nobody yet" for an empty group, "Opening…" for a pending boss. */
  note: HTMLElement;
  /** ＋ (boss and workers). */
  add?: HTMLButtonElement;
  list: HTMLElement;
  nodes: KeyedList<AgentNode>;
}

/** Others folded or not (remembered in the browser). */
const OTHERS_OPEN_KEY = 'habblaud.sidebar.othersOpen';

function readOthersOpen(): boolean {
  try {
    return localStorage.getItem(OTHERS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOthersOpen(open: boolean): void {
  try {
    localStorage.setItem(OTHERS_OPEN_KEY, open ? '1' : '0');
  } catch {
    // no storage: does not remember
  }
}

/** Role group titles and what they mean (the "hold Alt" notes, ui/hints.ts). */
function roleTitle(key: RoleKey): string {
  return key === 'boss' ? tr('👑 Boss') : key === 'workers' ? tr('Workers') : tr('Others');
}

function roleHint(key: RoleKey): string {
  if (key === 'boss') return tr('The one orchestrator: it gives the jobs to the workers. ＋ opens a new boss; or appoint an open session (👑 Make boss).');
  if (key === 'workers') return tr('Accounts registered as workers (Antigravity or Claude Code): only they get jobs, from the boss or from you. ＋ adds one.');
  return tr('Sessions that are neither boss nor worker (a boss that stepped down, a session asking something on the side). Click to fold.');
}

interface NodeRefs {
  row: HTMLButtonElement;
  /** Shortcut to agent's terminal window. */
  term: HTMLButtonElement;
  /** Row + shortcut: draggable to reorder agents in the room. */
  head: HTMLElement;
  /** The boss and the workers: their account's quota meters (5 h, week). */
  quota: HTMLElement;
  quotaRows: KeyedList<QuotaWindow>;
  subsWrap: HTMLElement;
  subsCaption: HTMLElement;
  subs: KeyedList<AgentInfo>;
}

export class Sidebar implements UiComponent {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private query = '';
  private scroller: HTMLElement;
  private roles: KeyedList<RoleGroup>;
  private roleRefs = new WeakMap<HTMLElement, RoleRefs>();
  private nodeRefs = new WeakMap<HTMLElement, NodeRefs>();
  /** Agents in each role group in displayed order (for drag and drop). */
  private shown = new Map<string, AgentNode[]>();
  private dragging: { id: string; group: string } | null = null;
  private empty: HTMLElement;
  private emptyText: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private lastSelKey = '';
  private othersOpen = readOthersOpen();
  /** Others shown unfolded for now (a search, or the selected agent is there), without changing the saved choice. */
  private othersForced = false;
  readonly dialogs: TeamDialogs;
  private readonly heading: HTMLElement;
  /** Boss and workers of the office shown (set each render). */
  private scope: RoleScope | undefined;

  constructor(private ctx: UiContext) {
    this.dialogs = new TeamDialogs(ctx);
    this.input = h('input', {
      class: 'ui-search__input',
      type: 'search',
      attrs: { placeholder: tr('Search for an agent, project or account'), 'aria-label': tr('Search for an agent, project or account'), autocomplete: 'off', spellcheck: 'false' },
    });
    this.input.addEventListener('input', () => {
      this.query = this.input.value;
      this.ctx.invalidate();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.input.value) {
          this.input.value = '';
          this.query = '';
          this.ctx.invalidate();
        } else {
          this.input.blur();
        }
      }
    });
    const searchIcon = h('span', { class: 'ui-search__icon', attrs: { 'aria-hidden': 'true' } });
    searchIcon.innerHTML = ICONS.search;
    const search = h('label', { class: 'ui-search', attrs: { 'data-hint': tr('Find an agent, project or account (/)') } }, searchIcon, this.input, h('kbd', { class: 'ui-kbd', text: '/', title: tr('Shortcut: /') }));

    this.scroller = h('div', { class: 'ui-side__scroll' });
    const list = h('div', { class: 'ui-rooms', role: 'list', attrs: { 'aria-label': tr('Agents by role') } });
    this.scroller.append(list);
    this.roles = new KeyedList<RoleGroup>(list, {
      key: (g) => g.key,
      create: (g) => this.createRole(g),
      update: (el, g) => this.updateRole(el, g),
    });

    this.emptyText = h('p');
    this.clearBtn = h('button', {
      class: 'ui-link-btn',
      type: 'button',
      text: tr('Clear the search'),
      on: {
        click: () => {
          this.input.value = '';
          this.query = '';
          this.ctx.invalidate();
        },
      },
    });
    this.empty = h('div', { class: 'ui-side__empty', hidden: true }, this.emptyText, this.clearBtn);
    this.scroller.append(this.empty);

    const close = iconButton(ICONS.close, tr('Close sidebar'), () => ctx.togglePanel('sidebar', false), 'ui-side__close');
    this.el = h(
      'aside',
      { class: 'ui-panel ui-sidebar', attrs: { 'aria-label': tr('Agents by role'), id: 'ui-sidebar', 'data-hint': tr('The boss, the workers and the other sessions: click one to select it') } },
      h('div', { class: 'ui-side__head' }, h('div', { class: 'ui-side__title' }, (this.heading = h('h2', { text: tr('Office') })), close), search),
      this.scroller,
    );
  }

  /** Mounted next to the other dialogs (ui/index.ts): a dialog inside a hidden sidebar could not open. */
  get dialogEl(): HTMLDialogElement {
    return this.dialogs.el;
  }

  focusSearch(): void {
    this.input.focus();
    this.input.select();
  }

  render(): void {
    const snap = this.ctx.store.snapshot;
    const office = this.ctx.selectedOffice();
    this.scope = roleScope(snap, office);
    setText(this.heading, office && teamOffices(snap?.team).length > 1 ? office.name : tr('Office'));
    const groups = groupRoles(snap, { query: this.query, hiddenAccounts: new Set() }, this.scope);
    const filtering = this.query.trim().length > 0;
    const sel = this.ctx.selection();
    const others = groups.find((g) => g.key === 'others');
    this.othersForced = this.query.trim().length > 0 || (sel?.type === 'agent' && !!others?.nodes.some((n) => n.agent.id === sel.id || n.subs.some((s) => s.id === sel.id)));
    this.roles.sync(groups);
    this.dialogs.render();

    const total = snap?.agents.length ?? 0;
    // Empty office without filters: center card already explains; list does not repeat warning.
    const showEmpty = groups.every((g) => !g.nodes.length) && (filtering || !officeIsEmpty(this.ctx));
    setHidden(this.empty, !showEmpty);
    if (showEmpty) {
      setText(
        this.emptyText,
        filtering && total > 0
          ? tr('No agents found for “{0}”.', [this.query.trim()])
          : tr('No open sessions right now.'),
      );
      setHidden(this.clearBtn, !(filtering && total > 0));
    }

    // On selection change (e.g. click on canvas), scrolls item into view.
    const selKey = sel ? `${sel.type}:${sel.id}` : '';
    if (selKey !== this.lastSelKey) {
      this.lastSelKey = selKey;
      if (sel?.type === 'agent') {
        this.el.querySelector<HTMLElement>(`.ui-agent[data-id="${CSS.escape(sel.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  /** Quota meters of the boss's or a worker's account: 5 h and week, with the exact % (orange at 50%, red at 80%). */
  private updateQuota(r: NodeRefs, a: AgentInfo, show: boolean): void {
    const acc = show ? this.ctx.account(a.account) : undefined;
    const wins = quotaWindows(acc, this.ctx.now());
    setHidden(r.quota, !wins.length);
    r.quotaRows.sync(wins);
    if (acc) setTitle(r.quota, tr('Quota of {0}', [acc.name]));
  }

  // ---------------------------------------------------------------- roles

  private createRole(g: RoleGroup): HTMLElement {
    const count = h('span', { class: 'ui-room__count' });
    const name = h('span', { class: 'ui-room__name', text: roleTitle(g.key) });
    const line = h('span', { class: 'ui-room__line' }, name, count);
    let head: HTMLElement;
    let add: HTMLButtonElement | undefined;
    if (g.key === 'others') {
      // Folding heading: a button with a chevron.
      const chevron = h('span', { class: 'ui-rolegroup__chevron', text: '▸', attrs: { 'aria-hidden': 'true' } });
      line.prepend(chevron);
      head = h('button', { class: 'ui-room__head ui-rolegroup__head ui-rolegroup__toggle', type: 'button', attrs: { 'data-hint': roleHint(g.key) }, on: { click: () => this.toggleOthers() } }, line);
    } else {
      const kind = g.key;
      add = h('button', { class: 'ui-icon-btn ui-icon-btn--sm ui-rolegroup__add', type: 'button', text: '＋', on: { click: () => this.dialogs.open(kind, add) } });
      setAttr(add, 'aria-haspopup', 'dialog');
      line.append(add);
      head = h('div', { class: 'ui-room__head ui-rolegroup__head', attrs: { 'data-hint': roleHint(g.key) } }, line);
    }
    const note = h('p', { class: 'ui-rolegroup__note', hidden: true });
    if (g.key === 'boss') {
      // A boss whose session is closed still holds the crown (and agy-ask's rule): let it go from here.
      const stepDown = h('button', {
        class: 'ui-btn ui-rolegroup__stepdown',
        type: 'button',
        text: tr('Step down'),
        title: tr('No boss until you appoint another session'),
        on: { click: () => void appointBoss(null, undefined, this.ctx.selectedOffice()?.id).catch(() => undefined) },
      });
      note.append(' ', stepDown);
    }
    const agentsEl = h('ul', { class: 'ui-nodes' });
    const section = h('section', { class: `ui-room ui-rolegroup is-${g.key}`, role: 'listitem' }, head, note, agentsEl);
    const nodes = new KeyedList<AgentNode>(agentsEl, {
      key: (n) => n.agent.id,
      create: (n) => this.createNode(n),
      update: (el, n) => this.updateNode(el, n),
    });
    this.roleRefs.set(section, { head, count, note, add, list: agentsEl, nodes });
    return section;
  }

  private toggleOthers(): void {
    this.othersOpen = !(this.othersOpen || this.othersForced);
    this.othersForced = false;
    writeOthersOpen(this.othersOpen);
    this.ctx.invalidate();
  }

  private updateRole(section: HTMLElement, g: RoleGroup): void {
    const r = this.roleRefs.get(section)!;
    setText(r.count, String(g.present));
    setTitle(r.count, plural(g.present, tr('agent'), tr('agents')));
    setHidden(r.count, !g.nodes.length);
    const text = this.roleNote(g);
    if (r.note.firstChild?.nodeType === Node.TEXT_NODE) r.note.firstChild.textContent = text;
    else r.note.prepend(text);
    const waiting = g.key === 'boss' && !!this.ctx.selectedOffice()?.waitingBoss && !this.ctx.store.mock;
    for (const b of r.note.querySelectorAll('button')) setHidden(b, !waiting);
    setHidden(r.note, g.nodes.length > 0);
    section.classList.toggle('is-empty', g.present === 0 && g.nodes.length > 0);
    if (g.key === 'others') {
      const open = this.othersOpen || this.othersForced;
      section.classList.toggle('is-folded', !open);
      setAttr(r.head, 'aria-expanded', String(open));
      setHidden(r.list, !open);
    }
    if (r.add) {
      const snap = this.ctx.store.snapshot;
      const blocked = g.key === 'boss' ? this.dialogs.bossBlocked() : snap?.team ? '' : tr('This Habblaud server does not keep a team yet (restart it to get one).');
      const label = g.key === 'boss' ? tr('Open a new boss') : tr('Add a worker');
      r.add.disabled = !snap || !!this.ctx.store.mock;
      setTitle(r.add, blocked ? `${label} — ${blocked}` : label);
      setAttr(r.add, 'aria-label', label);
    }
    // User-selected order (by dragging rows), saved in browser.
    const ordered = orderAgents(g.key, g.nodes, (n) => n.agent.sessionId);
    this.shown.set(g.key, ordered);
    r.nodes.sync(ordered);
  }

  /** Dragging a main agent row reorders agents in the same role group. */
  private wireDrag(head: HTMLElement): void {
    head.draggable = true;
    const id = () => head.dataset.id ?? '';
    const group = () => head.dataset.group ?? '';
    const after = (e: DragEvent) => {
      const rect = head.getBoundingClientRect();
      return e.clientY > rect.top + rect.height / 2;
    };
    const clear = () => {
      for (const el of this.el.querySelectorAll('.ui-node__head.is-drop-before, .ui-node__head.is-drop-after')) el.classList.remove('is-drop-before', 'is-drop-after');
    };
    head.addEventListener('dragstart', (e) => {
      this.dragging = { id: id(), group: group() };
      head.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id());
      }
    });
    head.addEventListener('dragend', () => {
      this.dragging = null;
      head.classList.remove('is-dragging');
      clear();
    });
    head.addEventListener('dragover', (e) => {
      const d = this.dragging;
      if (!d || d.group !== group() || d.id === id()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      clear();
      head.classList.add(after(e) ? 'is-drop-after' : 'is-drop-before');
    });
    head.addEventListener('dragleave', () => head.classList.remove('is-drop-before', 'is-drop-after'));
    head.addEventListener('drop', (e) => {
      const d = this.dragging;
      clear();
      if (!d || d.group !== group() || d.id === id()) return;
      e.preventDefault();
      const shown = this.shown.get(d.group) ?? [];
      if (moveAgent(d.group, shown, (n) => n.agent.id, (n) => n.agent.sessionId, d.id, id(), after(e))) this.ctx.invalidate();
    });
  }

  // ---------------------------------------------------------------- agents

  private createNode(n: AgentNode): HTMLElement {
    const row = createAgentRow(n.agent, (id) => this.pick(id));
    const subsCaption = h('span', { class: 'ui-subs__caption' });
    const subsList = h('ul', { class: 'ui-subs__list' });
    const subsWrap = h('div', { class: 'ui-subs', hidden: true }, subsCaption, subsList);
    // Sibling button to row (not inside it: button inside button is invalid), over right status: appears on
    // hover (or focus) and stays lit while agent's terminal is open.
    const term = h('button', { class: 'ui-node__term', type: 'button' });
    term.innerHTML = ICONS.terminal;
    term.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = row.dataset.id;
      if (id) this.ctx.terminals?.toggle(id, term);
    });
    const head = h('div', { class: 'ui-node__head' }, row, term);
    this.wireDrag(head);
    // The boss and the workers: how much of their account's quota is used.
    const quota = h('div', { class: 'ui-node__quota', hidden: true });
    const quotaRows = new KeyedList<QuotaWindow>(quota, {
      animate: false,
      key: (w) => w.label,
      create: () =>
        h('div', { class: 'ui-quota' }, h('span', { class: 'ui-quota__label' }), h('span', { class: 'ui-quota__bar' }, h('span', { class: 'ui-quota__fill' })), h('span', { class: 'ui-quota__pct' })),
      update: (el, w) => {
        const [label, bar, pct] = [...el.children] as HTMLElement[];
        setText(label, w.label);
        (bar.firstElementChild as HTMLElement).style.width = `${w.pct === null ? 0 : Math.max(2, Math.min(100, w.pct))}%`;
        setText(pct, w.pct === null ? '—' : `${Math.round(w.pct)}%`);
        setVariant(el, 'is-', w.pct === null ? 'none' : usageLevel(w.pct));
        setTitle(el, w.pct === null ? tr('{0}: reset since the last reading', [w.name]) : `${w.name}: ${Math.round(w.pct)}%${w.reset ? ` · ↻ ${w.reset}` : ''}`);
      },
    });
    const li = h('li', { class: 'ui-node' }, head, quota, subsWrap);
    const subs = new KeyedList<AgentInfo>(subsList, {
      key: (a) => a.id,
      create: (a) => h('li', { class: 'ui-subs__item' }, createAgentRow(a, (id) => this.pick(id), 'sm')),
      update: (li2, a) => this.updateRow(li2.firstElementChild as HTMLElement, a),
    });
    this.nodeRefs.set(li, { row, head, term, quota, quotaRows, subsWrap, subsCaption, subs });
    return li;
  }

  private updateNode(li: HTMLElement, n: AgentNode): void {
    const r = this.nodeRefs.get(li)!;
    this.updateRow(r.row, n.agent);
    r.head.dataset.id = n.agent.id;
    r.head.dataset.group = roleKey(n.agent, this.ctx.store.snapshot?.team, this.scope, this.ctx.store.snapshot);
    this.updateQuota(r, n.agent, r.head.dataset.group === 'workers' || r.head.dataset.group === 'boss');
    // Where it works (grouped by role, the folder is no longer the heading); workers all share one room.
    const room = n.agent.provider === 'agy' ? undefined : this.ctx.store.room(n.agent.roomId);
    setAgentRowPlace(r.row, room ? `📁 ${room.name}` : '', room?.path);
    const router = this.ctx.terminals;
    const a = n.agent;
    // A worker's character has a terminal only while its session runs one (else nothing to open).
    const session = sessionOfAgent(this.ctx.store.snapshot?.team, a.id);
    const canTerm = !!router?.available && a.status !== 'offline' && (!session || !!session.ptyId);
    setHidden(r.term, !canTerm);
    if (canTerm && router) {
      const open = router.openAgentId === a.id;
      const live = router.interactive(a.id);
      r.term.classList.toggle('is-on', open);
      r.term.classList.toggle('is-live', live);
      const what = live ? tr('interactive') : tr('live');
      setTitle(r.term, open ? tr('Close the terminal') : tr("Open {0}'s terminal ({1})", [a.name, what]));
      setAttr(r.term, 'aria-label', open ? tr("Close {0}'s terminal", [a.name]) : tr("Open {0}'s terminal", [a.name]));
    }
    const has = n.subTotal > 0;
    setHidden(r.subsWrap, !has);
    if (has) {
      const shown = n.subs.length;
      setText(r.subsCaption, shown === n.subTotal ? plural(n.subTotal, tr('subagent'), tr('subagents')) : tr('{0} of {1}', [shown, plural(n.subTotal, tr('subagent'), tr('subagents'))]));
    }
    r.subs.sync(n.subs);
  }

  private updateRow(row: HTMLElement, a: AgentInfo): void {
    const sel = this.ctx.selection();
    updateAgentRow(row, a, this.ctx.account(a.account), sel?.type === 'agent' && sel.id === a.id, this.ctx.now(), this.ctx.store.snapshot?.agents);
  }

  /** What an empty group says. */
  private roleNote(g: RoleGroup): string {
    if (g.key === 'boss') {
      const team = this.ctx.selectedOffice();
      if (team?.pendingBoss) return tr('Opening the new boss…');
      if (team?.waitingBoss) return tr('👑 {0} is the boss, but its session is closed: the crown waits for it (claude --resume), and until then agy-ask / claude-ask refuse everyone else.', [team.waitingBoss]);
      return tr('Nobody yet: ＋ opens a new boss, or press “👑 Make boss” on an open Claude session.');
    }
    if (g.key === 'workers') return tr('Nobody yet: ＋ registers an Antigravity or Claude Code account.');
    return '';
  }

  private pick(id: string): void {
    this.ctx.select({ type: 'agent', id }, { focus: true });
    // With a terminal open, clicking another agent switches terminal to theirs.
    const t = this.ctx.terminals;
    if (t && t.openAgentId !== null && t.openAgentId !== id && this.ctx.agent(id)) t.open(id);
    if (this.ctx.isNarrow()) this.ctx.togglePanel('sidebar', false);
  }
}
