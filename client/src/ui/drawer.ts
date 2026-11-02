// Details drawer (right): selected agent or room. Codex agent: "Codex" badge, Codex copy (where
// to reply, the terminal, approval instead of permission mode, no cost) and Codex hooks hint.
import type { Activity, AgentInfo, FeedItem, RoomInfo, ShellJob, TaskItem } from '../../../shared/types';
import { roomTheme } from '../art';
import { createAvatarPlaceholder, updateAvatar } from './avatar';
import { CharacterEditor } from './character-editor';
import { AgyDefaultsPanel, AgyPanel, WorkerTerminalPanel } from './agy-panel';
import { SessionControls } from './session-controls';
import { AgyProgressView } from './agy-progress';
import { MessageComposer } from './composer';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatInt,
  formatTokens,
  formatUSD,
  permissionLabel,
  plural,
  prettyModel,
  relativeTime,
  shortPath,
} from './format';
import { ICONS } from './icons';
import {
  accountsOf,
  activityFallback,
  aggregateTasks,
  mergeHistory,
  roleLabel,
  shellBoxText,
  shellDoneKind,
  shellKindLabel,
  shellStage,
  shellWaitIn,
  sortByUrgency,
  statusLabel,
  taskProgress,
  visibleShells,
} from './model';
import { access } from '../net/access';
import { PermissionCard } from './permission';
import { canRenameRoom } from './roomrename';
import { sessionOfAgent, setWorker, workerOfAgent } from './workers-api';
import { bossOfficeOf, officeForWorker, teamOffices } from './offices';
import { accountChipLabel, accountProvider, CODEX_LIVE_HINT, codexApprovalLabel, providerOf } from './provider';
import { postPty, ptyControllable } from './ptyapi';
import { createAgentRow, updateAgentRow } from './rows';
import { SocialSection } from './social';
import { TERMINAL_UNAVAILABLE_HINT, type TerminalControl } from './terminal';
import { Movable } from './movable';
import type { PtyControl } from './pty';
import { richText } from './usage';
import {
  createAccountChip,
  createProgress,
  createProviderTag,
  createStatusDot,
  updateAccountChip,
  updateProgress,
  updateProviderTag,
  updateStatusDot,
} from './widgets';
import { tr } from '../../../shared/i18n';

/** Timeline items shown initially; "Show more" adds another batch. */
const TIMELINE_STEP = 15;
const ROOM_FEED_LIMIT = 15;

// ---------------------------------------------------------------- components

/**
 * Quick orders for the boss: [button label, text sent to input]. Claude receives it as if typed
 * and uses agy-ask / claude-ask (skill agy-orchestrator) to command workers.
 */
function bossOrders(): Array<[string, string]> {
  return [
    [tr('📋 Distribute'), tr('Split this task among the free workers (agy-ask / claude-ask with --role, in parallel) and bring me a summary: ')],
    [tr('📊 Report'), tr('Workers report: what each one is doing, what finished, and how much quota is left (agy /usage for Antigravity workers).')],
    [tr('🔍 Review'), tr('Ask a free worker (--role review, --mode plan) to review the last delivered job, and check the serious findings yourself.')],
    [tr('🛑 Stop all'), tr('Stop every running worker job and tell me what was interrupted.')],
  ];
}

function section(title: string, ...children: (Node | null)[]): { el: HTMLElement; title: HTMLElement; extra: HTMLElement } {
  const t = h('h3', { class: 'ui-sec__title', text: title });
  const extra = h('span', { class: 'ui-sec__extra' });
  const el = h('section', { class: 'ui-sec' }, h('div', { class: 'ui-sec__head' }, t, extra), ...children.filter((c): c is Node => !!c));
  return { el, title: t, extra };
}

function copyButton(getText: () => string, label: string): HTMLButtonElement {
  const b = iconButton(ICONS.copy, label, async () => {
    const ok = await copyText(getText());
    b.classList.toggle('is-done', ok);
    b.innerHTML = ok ? ICONS.check : ICONS.copy;
    setTitle(b, ok ? tr('Copied!') : tr("Couldn't copy"));
    setTimeout(() => {
      b.classList.remove('is-done');
      b.innerHTML = ICONS.copy;
      setTitle(b, label);
    }, 1400);
  }, 'ui-icon-btn--sm');
  return b;
}

const TASK_MARK: Record<TaskItem['status'], string> = { completed: '✓', in_progress: '◐', pending: '○' };
const TASK_STATE: Record<TaskItem['status'], string> = { completed: tr('completed'), in_progress: tr('in progress'), pending: tr('pending') };

function createTaskItem(): HTMLElement {
  return h('li', { class: 'ui-task' }, h('span', { class: 'ui-task__mark', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'ui-task__text' }), h('span', { class: 'ui-task__owner' }));
}

function updateTaskItem(li: HTMLElement, t: TaskItem, owner?: string): void {
  const [mark, text, ownerEl] = li.children as unknown as HTMLElement[];
  setText(mark, TASK_MARK[t.status]);
  setText(text, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.title);
  setText(ownerEl, owner ?? '');
  setHidden(ownerEl, !owner);
  setVariant(li, 'is-', t.status);
  setAttr(li, 'aria-label', `${t.title}: ${TASK_STATE[t.status]}`);
}

function createTimelineItem(): HTMLElement {
  return h(
    'li',
    { class: 'ui-tl' },
    h('span', { class: 'ui-tl__icon', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'ui-tl__text' }),
    h('time', { class: 'ui-tl__time' }),
  );
}

function updateTimelineItem(li: HTMLElement, a: Activity, now: number, who?: string): void {
  const [icon, text, time] = li.children as unknown as HTMLElement[];
  setText(icon, a.icon);
  setText(text, who ? `${who}: ${a.text}` : a.text);
  setText(time, relativeTime(a.at, now));
  setAttr(time, 'datetime', new Date(a.at).toISOString());
  setTitle(li, `${formatClock(a.at)} · ${a.text}${a.detail ? `\n${a.detail}` : ''}`);
  li.classList.toggle('is-error', !!a.error);
  const done = shellDoneKind(a);
  li.classList.toggle('is-shell-ok', done === 'ok');
  li.classList.toggle('is-shell-fail', done === 'fail');
}

// ---------------------------------------------------------------- running shells

interface ShellRefs {
  icon: HTMLElement;
  label: HTMLElement;
  time: HTMLElement;
  badge: HTMLElement;
  since: HTMLElement;
  details: HTMLDetailsElement;
  command: HTMLElement;
}

const shellRefs = new WeakMap<HTMLElement, ShellRefs>();

const SHELL_KIND_VARIANT = (j: ShellJob): string => (j.kind === 'monitor' ? 'monitor' : j.background ? 'bg' : 'fg');

function createShellItem(): HTMLElement {
  const icon = h('span', { class: 'ui-shell__icon', attrs: { 'aria-hidden': 'true' } });
  const label = h('span', { class: 'ui-shell__label' });
  const time = h('time', { class: 'ui-shell__time' });
  const badge = h('span', { class: 'ui-shell__badge' });
  const since = h('span', { class: 'ui-shell__since' });
  const command = h('pre', { class: 'ui-mono' });
  const details = h(
    'details',
    { class: 'ui-shell__cmd' },
    h('summary', { text: tr('Command') }),
    h('div', { class: 'ui-shell__cmd-body' }, command, copyButton(() => command.textContent ?? '', tr('Copy command'))),
  );
  const li = h('li', { class: 'ui-shell' }, h('div', { class: 'ui-shell__head' }, icon, label, time), h('div', { class: 'ui-shell__meta' }, badge, since), details);
  shellRefs.set(li, { icon, label, time, badge, since, details, command });
  return li;
}

function updateShellItem(li: HTMLElement, j: ShellJob, now: number): void {
  const r = shellRefs.get(li)!;
  setText(r.icon, j.kind === 'monitor' ? '📡' : '💻');
  setText(r.label, j.label);
  setTitle(r.label, j.label);
  const elapsed = Math.max(0, now - j.startedAt);
  setText(r.time, formatElapsed(elapsed));
  setAttr(r.time, 'datetime', new Date(j.startedAt).toISOString());
  setTitle(r.time, tr('Running for {0} (since {1})', [formatDuration(elapsed), formatClock(j.startedAt)]));
  setText(r.badge, shellKindLabel(j));
  setVariant(r.badge, 'ui-shell__badge--', SHELL_KIND_VARIANT(j));
  setText(r.since, tr('since {0}', [formatClock(j.startedAt, false)]));
  setTitle(r.since, tr('Started {0} · id {1}', [formatDateTime(j.startedAt), j.id]));
  setHidden(r.details, !j.command);
  setText(r.command, j.command ?? '');
  setAttr(li, 'aria-label', tr('{0}, {1}, running for {2}', [j.label, shellKindLabel(j), formatDuration(elapsed)]));
}


// ---------------------------------------------------------------- agent view

class AgentView {
  readonly el: HTMLElement;
  private id = '';
  private last: AgentInfo | null = null;
  private history: Activity[] = [];
  private historyReq = 0;
  /** Increments when switching live ↔ replay or rewinding: previous generation responses are discarded. */
  private historyGen = 0;
  /** Source and timestamp of last timeline (to detect switching and rewinding). */
  private historyReplay = false;
  private historyAt = 0;
  private historyBound = false;

  private avatar: HTMLElement;
  private name: HTMLElement;
  private role: HTMLElement;
  private title: HTMLElement;
  private accChip: HTMLElement;
  private accName: HTMLElement;
  private accProv: HTMLElement;
  private accEmail: HTMLElement;
  /** Codex hooks hint (live mode and approve from office), in the drawer of a Codex agent. */
  private codexHint: HTMLElement;
  private roomBtn: HTMLButtonElement;
  private roomName: HTMLElement;
  private gone: HTMLElement;
  private dot: HTMLElement;
  private statusText: HTMLElement;
  private statusSince: HTMLElement;
  private followBtn: HTMLButtonElement;
  /** "👑 Make boss" / "Step down": appoints the one orchestrator (POST /api/team, server/team.ts). */
  private bossBtn: HTMLButtonElement;
  private termBtn: HTMLButtonElement;
  private termLabel: HTMLElement;
  /** Why terminal does not open: mobile has no hover to read title, so tapping displays reason here. */
  private termWhy: HTMLElement;
  private termWhyTimer: ReturnType<typeof setTimeout> | null = null;
  /** "Remove from Workers": unregisters a worker (POST /api/team, ui/workers-api.ts). */
  private workerBtn: HTMLButtonElement;
  /** "🖥 Terminal": a worker's open terminal (ui/agy-panel.ts). */
  private workerTerm: WorkerTerminalPanel;
  private workerTermSec: ReturnType<typeof section>;
  private alert: HTMLElement;
  private alertText: HTMLElement;
  /**
   * Pending AskUserQuestion questions and options, read-only: with request in office (permission
   * hook), the answer card appears instead of the alert.
   */
  private alertQuestions: HTMLElement;
  private alertQuestionsKey = '';
  /** Hint on how to answer questions from here (permissions plugin). */
  private alertAnswerHint: HTMLElement;
  /** Permission request (or question) to answer from here (replaces generic alert while active). */
  private perm: PermissionCard;
  private shellBox: HTMLElement;
  private shellText: HTMLElement;
  private shellMood: HTMLElement;
  private shellNext: HTMLElement;
  private shellsSec: ReturnType<typeof section>;
  private shells: KeyedList<ShellJob>;
  private actIcon: HTMLElement;
  private actText: HTMLElement;
  private actTime: HTMLElement;
  private actDetails: HTMLDetailsElement;
  private actDetail: HTMLElement;
  /** Send message to main agent via Habblaud (habblaud-mensagens plugin). */
  private composer: MessageComposer;
  private msgSec: ReturnType<typeof section>;
  /** Antigravity worker in manual mode: "Send a job" (ui/agy-panel.ts). */
  private agyPanel: AgyPanel;
  /** Antigravity worker: mode and effort for jobs that do not say (every worker, local only). */
  private agyDefaults: AgyDefaultsPanel;
  private agyDefaultsSec: ReturnType<typeof section>;
  /** Claude Code session: model, effort and plan mode from the office (ui/session-controls.ts). */
  private sessionCtl: SessionControls;
  private sessionSec: ReturnType<typeof section>;
  private orders: HTMLElement;
  private agySec: ReturnType<typeof section>;
  private agyProgress = new AgyProgressView();
  private agyProgressSec: ReturnType<typeof section>;
  private tasksSec: ReturnType<typeof section>;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<TaskItem>;
  private teamSec: ReturnType<typeof section>;
  private team: KeyedList<AgentInfo>;
  private teamEmpty: HTMLElement;
  private timeline: KeyedList<Activity>;
  private timelineSec: ReturnType<typeof section>;
  private timelineMore: HTMLButtonElement;
  private timelineLess: HTMLButtonElement;
  /** How many timeline items are currently shown. */
  private timelineShown = TIMELINE_STEP;
  private stats: KvList<StatKey>;
  private social: SocialSection;
  readonly character: CharacterEditor;
  private sessionValue: HTMLElement;
  private linesPlus: HTMLElement;
  private linesMinus: HTMLElement;
  private termRo: HTMLElement;

  constructor(
    private ctx: UiContext,
    private terminal: TerminalControl,
    private pty: PtyControl,
  ) {
    this.avatar = createAvatarPlaceholder('lg');
    this.name = h('h2', { class: 'ui-hero__name' });
    this.role = h('span', { class: 'ui-role' });
    this.title = h('p', { class: 'ui-hero__title' });
    this.accChip = createAccountChip('md');
    this.accName = h('span', { class: 'ui-hero__acc-name' });
    this.accProv = createProviderTag('ui-prov--xs');
    this.accEmail = h('span', { class: 'ui-hero__acc-email' });
    this.roomName = h('span');
    this.roomBtn = h('button', { class: 'ui-room-link', type: 'button', on: { click: () => this.last && ctx.select({ type: 'room', id: this.last.roomId }, { focus: true }) } }, this.roomName);
    this.character = new CharacterEditor(ctx);
    const heroText = h(
      'div',
      { class: 'ui-hero__text' },
      h('div', { class: 'ui-hero__line' }, this.name, this.character.button, this.role),
      h('div', { class: 'ui-hero__acc' }, this.accChip, this.accName, this.accProv, this.accEmail),
      h('div', { class: 'ui-hero__where' }, h('span', { class: 'ui-muted', text: tr('Room') }), this.roomBtn),
    );
    this.gone = h('p', { class: 'ui-gone', text: tr('This agent has already left the office.'), hidden: true });

    this.dot = createStatusDot();
    this.statusText = h('span', { class: 'ui-status__text' });
    this.statusSince = h('span', { class: 'ui-status__since' });
    this.followBtn = h('button', { class: 'ui-btn', type: 'button', attrs: { 'aria-pressed': 'false' }, title: tr('Camera follows the agent (F)'), on: { click: () => this.toggleFollow() } });
    this.followBtn.innerHTML = ICONS.follow;
    this.followBtn.append(h('span', { text: tr('Follow') }));
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: tr('Move the camera to the agent'), on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: tr('Center') }));
    this.bossBtn = h('button', {
      class: 'ui-btn ui-btn-boss',
      type: 'button',
      hidden: true,
      attrs: { 'data-hint': tr('Only one boss (orchestrator): it gives the jobs to the workers. Appointing this session takes the crown from the current boss.') },
      on: { click: () => void this.toggleBoss() },
    });
    this.workerBtn = h('button', {
      class: 'ui-btn',
      type: 'button',
      hidden: true,
      text: tr('Remove from Workers'),
      title: tr('This account stops getting jobs and leaves the office; ＋ in the Workers group brings it back.'),
      attrs: { 'data-hint': tr('Unregisters this account as a worker: it stops getting jobs and leaves the office.') },
      on: { click: () => void this.removeWorker() },
    });
    const statusRow = h(
      'div',
      { class: 'ui-status' },
      h('span', { class: 'ui-status__label' }, this.dot, this.statusText, this.statusSince),
      h('span', { class: 'ui-status__actions' }, this.bossBtn, this.workerBtn, this.followBtn, centerBtn),
    );

    // Terminal: session conversation as Claude Code displays it, live (local access only).
    this.termLabel = h('span', { class: 'ui-term-cta__label', text: tr('Open terminal') });
    const termIcon = h('span', { class: 'ui-term-cta__icon', attrs: { 'aria-hidden': 'true' } });
    termIcon.innerHTML = ICONS.terminal;
    this.termBtn = h(
      'button',
      {
        class: 'ui-btn ui-term-cta',
        type: 'button',
        attrs: { 'aria-pressed': 'false', 'data-hint': tr("Shows this session's conversation live, as in Claude Code; you can type in it when the session runs here") },
        on: { click: () => this.toggleTerminal() } },
      termIcon,
      this.termLabel,
      (this.termRo = h('span', { class: 'ui-term-cta__ro', text: tr('live') })),
      h('kbd', { class: 'ui-kbd', text: 'T', attrs: { 'aria-hidden': 'true' } }),
    );

    this.termWhy = h('p', { class: 'ui-term-cta__why', hidden: true, attrs: { role: 'status' } });

    this.alertText = h('p', { class: 'ui-alert__text' });
    this.alertQuestions = h('div', { class: 'ui-ask', hidden: true });
    this.alertAnswerHint = h('p', { class: 'ui-ask__answer-hint', hidden: true, text: tr('With the habblaud-permissoes plugin (npm run mod:install), you can answer questions from here.') });
    const alertIcon = h('span', { class: 'ui-alert__icon', attrs: { 'aria-hidden': 'true' } });
    alertIcon.innerHTML = ICONS.hand;
    this.alert = h(
      'div',
      { class: 'ui-alert', role: 'alert', hidden: true },
      alertIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: tr('Needs you') }), this.alertText, this.alertQuestions, this.alertAnswerHint),
    );

    // Waiting on shell: status box (with office waiting stage) and list of running commands.
    this.shellText = h('p', { class: 'ui-alert__text' });
    this.shellMood = h('span', { class: 'ui-shell-mood__text' });
    this.shellNext = h('span', { class: 'ui-shell-mood__next' });
    const shellIcon = h('span', { class: 'ui-alert__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
    shellIcon.innerHTML = ICONS.hourglass;
    this.shellBox = h(
      'div',
      { class: 'ui-alert ui-alert--shell', hidden: true },
      shellIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: tr('Waiting on shell') }), this.shellText, h('p', { class: 'ui-shell-mood' }, this.shellMood, this.shellNext)),
    );
    const shellList = h('ul', { class: 'ui-shells' });
    this.shellsSec = section(tr('Running shells'), shellList);
    this.shells = new KeyedList<ShellJob>(shellList, { key: (j) => j.id, create: createShellItem, update: (li, j) => updateShellItem(li, j, ctx.now()) });

    this.actIcon = h('span', { class: 'ui-now__icon', attrs: { 'aria-hidden': 'true' } });
    this.actText = h('span', { class: 'ui-now__text' });
    this.actTime = h('span', { class: 'ui-now__time' });
    this.actDetail = h('pre', { class: 'ui-mono' });
    this.actDetails = h('details', { class: 'ui-now__details' }, h('summary', { text: tr('Details') }), this.actDetail);
    const nowSec = section(tr('Now'), h('div', { class: 'ui-now' }, this.actIcon, h('div', { class: 'ui-now__body' }, this.actText, this.actTime)), this.actDetails);
    this.composer = new MessageComposer(ctx, 'drawer');
    // Quick orders for boss (Claude commanding Antigravity workers): prefill input with command.
    this.orders = h(
      'div',
      { class: 'ui-boss-orders', hidden: true },
      ...bossOrders().map(([label, text]) =>
        h('button', { class: 'ui-btn ui-boss-orders__btn', type: 'button', text: label, title: text, on: { click: () => this.composer.prefill(text) } }),
      ),
    );
    this.msgSec = section(tr('Send message'), this.orders, this.composer.el);
    this.agyPanel = new AgyPanel(ctx);
    this.agySec = section(tr('Send a job'), this.agyPanel.el);
    this.agyDefaults = new AgyDefaultsPanel(ctx);
    this.workerTerm = new WorkerTerminalPanel(ctx);
    this.workerTermSec = section(tr('🖥 Terminal'), this.workerTerm.el);
    this.agyDefaultsSec = section(tr('Defaults for jobs'), this.agyDefaults.el);
    this.sessionCtl = new SessionControls(ctx);
    this.sessionSec = section(tr('Model and effort'), this.sessionCtl.el);
    this.agyProgressSec = section(tr('Level'), this.agyProgress.el);
    // "hold Alt" notes (ui/hints.ts) on the section titles
    this.msgSec.title.dataset.hint = tr('Types a message into this session, as if you wrote it in its terminal');
    this.agySec.title.dataset.hint = tr('Gives this worker a job, like the boss does with agy-ask / claude-ask');
    this.agyDefaultsSec.title.dataset.hint = tr("Mode and effort this worker uses when a job doesn't say");
    this.sessionSec.title.dataset.hint = tr('Model and effort for this session only, from its next answer; new sessions keep your defaults');
    this.agyProgressSec.title.dataset.hint = tr("This worker's level, XP and badges, earned from finished jobs");
    // On mobile, the box stays pinned to drawer footer while scrolling (styles.css, .ui-sec--msg).
    this.msgSec.el.classList.add('ui-sec--msg');
    this.social = new SocialSection(ctx);
    this.perm = new PermissionCard(ctx);

    this.tasksBar = createProgress(tr('Task progress'));
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section(tr('Tasks'), this.tasksBar, tasksList);
    this.tasks = new KeyedList<TaskItem>(tasksList, { key: (t) => t.id, create: createTaskItem, update: (li, t) => updateTaskItem(li, t) });

    const teamList = h('div', { class: 'ui-team' });
    this.teamEmpty = h('p', { class: 'ui-muted ui-small', text: tr('No subagents right now.') });
    this.teamSec = section(tr('Subagents'), teamList, this.teamEmpty);
    this.team = new KeyedList<AgentInfo>(teamList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    const tl = h('ol', { class: 'ui-timeline' });
    this.timelineMore = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', on: { click: () => this.showTimeline(this.timelineShown + TIMELINE_STEP) } });
    this.timelineLess = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Show less'), on: { click: () => this.showTimeline(TIMELINE_STEP) } });
    this.timelineSec = section(tr('Timeline'), tl, h('div', { class: 'ui-timeline__more' }, this.timelineMore, this.timelineLess));
    this.timeline = new KeyedList<Activity>(tl, { key: (a) => a.id, create: createTimelineItem, update: (li, a) => updateTimelineItem(li, a, ctx.now()) });

    this.sessionValue = h('span', { class: 'ui-mono-inline' });
    this.linesPlus = h('span', { class: 'ui-plus' });
    this.linesMinus = h('span', { class: 'ui-minus' });
    this.stats = new KvList<StatKey>([
      ['tools', tr('Tool calls')],
      ['tokensIn', tr('Input tokens')],
      ['tokensOut', tr('Output tokens')],
      ['cost', tr('Estimated cost')],
      ['lines', tr('Lines'), h('span', { class: 'ui-lines' }, this.linesPlus, this.linesMinus)],
      ['subs', tr('Subagents launched')],
      ['model', tr('Model')],
      ['effort', tr('Effort')],
      ['branch', 'Branch'],
      ['perm', tr('Permissions')],
      ['session', tr('Session'), h('span', { class: 'ui-copy-row' }, this.sessionValue, copyButton(() => this.last?.sessionId ?? '', tr('Copy session id')))],
      ['start', tr('Start')],
      ['duration', tr('Duration')],
      ['bg', tr('Execution')],
    ]);
    const statsSec = section(tr('Stats'), this.stats.el);
    this.codexHint = h('p', { class: 'ui-codex-hint', hidden: true }, ...richText(CODEX_LIVE_HINT));

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-agent-view' },
      h('div', { class: 'ui-hero' }, this.avatar, heroText),
      this.character.el,
      this.title,
      this.gone,
      statusRow,
      this.termBtn,
      this.termWhy,
      this.alert,
      this.perm.el,
      this.shellBox,
      this.shellsSec.el,
      nowSec.el,
      this.workerTermSec.el,
      this.agyDefaultsSec.el,
      this.agySec.el,
      this.agyProgressSec.el,
      this.sessionSec.el,
      this.msgSec.el,
      this.social.el,
      this.tasksSec.el,
      this.teamSec.el,
      this.timelineSec.el,
      statsSec.el,
      this.codexHint,
    );
  }

  get agentId(): string {
    return this.id;
  }

  open(id: string): void {
    if (this.id === id) return;
    this.character.open(id);
    this.id = id;
    this.last = null;
    this.history = [];
    this.timelineShown = TIMELINE_STEP;
    this.timeline.clear();
    this.tasks.clear();
    this.team.clear();
    this.shells.clear();
    this.actDetails.open = false;
    this.loadHistory();
  }

  /** Long agent history (most recent request wins; see historyGen). */
  private loadHistory(): void {
    const id = this.id;
    if (!id) return;
    const req = ++this.historyReq;
    const gen = this.historyGen;
    this.ctx.store
      .agentHistory(id)
      .then((hist) => {
        // Another agent (req) or source switch/rewind midway (gen): response is no longer valid.
        if (req !== this.historyReq || gen !== this.historyGen) return;
        this.history = mergeHistory(hist, this.history, 200, this.ctx.store.replaying ? this.ctx.store.snapshot?.serverTime : undefined);
        this.ctx.invalidate();
      })
      .catch(() => {
        // Without long history: timeline uses recent activities from snapshot.
      });
  }

  /**
   * In replay, timeline stops at playback timestamp. Switching source or rewinding invalidates
   * in-flight request; on switch, restarts from snapshot (and, back live, fetches history again).
   */
  private historyUntil(): number | undefined {
    const replaying = this.ctx.store.replaying;
    const at = this.ctx.store.snapshot?.serverTime ?? 0;
    if (this.historyBound) {
      const sourceChanged = replaying !== this.historyReplay;
      const rewound = replaying && at < this.historyAt;
      if (sourceChanged || rewound) {
        this.historyGen++;
        if (sourceChanged) {
          this.history = [];
          if (!replaying) this.loadHistory();
        }
      }
    }
    this.historyBound = true;
    this.historyReplay = replaying;
    this.historyAt = at;
    return replaying ? at : undefined;
  }

  /** Opens (or closes) this agent's terminal; disabled without local access or after agent leaves. */
  toggleTerminal(): void {
    if (!this.id) return;
    if (this.termBtn.getAttribute('aria-disabled') === 'true') {
      // On mobile there is no hover to read tooltip: tap shows reason below button.
      const why = this.termBtn.title;
      setText(this.termWhy, why);
      setHidden(this.termWhy, false);
      this.ctx.announce(why);
      if (this.termWhyTimer) clearTimeout(this.termWhyTimer);
      this.termWhyTimer = setTimeout(() => setHidden(this.termWhy, true), 8_000);
      return;
    }
    setHidden(this.termWhy, true);
    if (this.ctx.terminals) this.ctx.terminals.toggle(this.id, this.termBtn);
    else this.terminal.toggle(this.id, this.termBtn);
  }

  private async removeWorker(): Promise<void> {
    const a = this.last;
    if (!a || this.workerBtn.disabled) return;
    this.workerBtn.disabled = true;
    try {
      const worker = workerOfAgent(this.ctx.store.snapshot?.team, a);
      if (!worker) return;
      await setWorker(worker, false, officeForWorker(this.ctx.selectedOffice(), worker));
      this.ctx.announce(tr('{0} is no longer a worker.', [a.name]));
    } catch (err) {
      this.ctx.announce(tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
    } finally {
      this.workerBtn.disabled = false;
    }
  }

  private showTimeline(n: number): void {
    this.timelineShown = Math.max(TIMELINE_STEP, n);
    this.ctx.invalidate();
  }

  private async toggleBoss(): Promise<void> {
    const a = this.last;
    if (!a || this.bossBtn.disabled) return;
    this.bossBtn.disabled = true;
    try {
      const office = a.boss ? bossOfficeOf(this.ctx.store.snapshot, a.id) : this.ctx.selectedOffice();
      await postPty('/api/team', { ...(office ? { office: office.id } : {}), boss: a.boss ? null : a.id });
      this.bossBtn.disabled = false;
    } catch (err) {
      // on the button for a moment (e.g. opened over remote access, where appointing is not allowed)
      const msg = err instanceof Error ? err.message : String(err);
      setText(this.bossBtn, `⚠️ ${msg}`);
      this.ctx.announce(msg);
      setTimeout(() => {
        this.bossBtn.disabled = false;
        this.ctx.invalidate();
      }, 3_000);
    }
  }

  toggleFollow(): void {
    const follow = !this.ctx.world.getOptions().followSelected;
    this.ctx.world.setOptions({ followSelected: follow });
    // Refocus with new option: enabling starts following; disabling keeps agent centered and still.
    if (this.id) this.ctx.focusSelection();
    this.ctx.invalidate();
  }

  render(): void {
    const live = this.ctx.agent(this.id);
    if (live) this.last = live;
    const a = this.last;
    if (!a) return;
    const now = this.ctx.now();
    const account = this.ctx.account(a.account);
    const room = this.ctx.store.room(a.roomId);
    const provider = providerOf(a);
    const codex = provider === 'codex';

    updateAvatar(this.avatar, a, 'lg');
    setStyleVar(this.avatar, '--acc', account?.color ?? '#8b98b3');
    setText(this.name, a.name);
    this.character.render(a, !!live);
    setText(this.role, roleLabel(a));
    setVariant(this.role, 'ui-role--', a.kind);
    setText(this.title, a.title ?? '');
    setHidden(this.title, !a.title);
    const team = this.ctx.store.snapshot?.team;
    const worker = team ? workerOfAgent(team, a) : undefined;
    const workerSession = sessionOfAgent(team, a.id);
    // Appoint the boss: an open Claude Code main session (not a demo one), not a worker's character (＋ Boss with
    // that account makes it the boss; it then leaves Workers).
    setHidden(this.bossBtn, !live || !ptyControllable(a) || !!workerSession);
    // (while busy, the button may be showing an error)
    // Several offices: appointing makes it the boss of the office shown; stepping down leaves its own office.
    const office = this.ctx.selectedOffice();
    const many = teamOffices(team).length > 1;
    if (!this.bossBtn.disabled) setText(this.bossBtn, a.boss ? tr('Step down') : many && office ? tr('👑 Make boss of {0}', [office.name]) : tr('👑 Make boss'));
    this.bossBtn.title = a.boss ? tr('No boss until you appoint another session') : tr('Make this session the boss (orchestrator)');
    // (removes it from the office shown; a worker of another office only is removed from there)
    setHidden(this.workerBtn, !live || !worker || (many && !officeForWorker(office, worker)) || access().remote || this.ctx.store.mock);
    setTitle(this.title, a.title ?? '');
    updateAccountChip(this.accChip, account, a.account, a.provider);
    setText(this.accName, account?.name ?? a.account);
    updateProviderTag(this.accProv, provider, account?.name ?? '');
    // Email (Claude Code) or, on Codex (no email), the plan.
    const accSub = account?.email ?? (codex && account?.plan ? tr('{0} plan', [account.plan]) : '');
    setText(this.accEmail, accSub);
    setHidden(this.accEmail, !accSub);
    setText(this.roomName, room?.name ?? a.roomId);
    setTitle(this.roomBtn, room ? tr('{0}\nClick to view the room', [room.path]) : '');
    setHidden(this.gone, !!live);
    this.el.classList.toggle('is-gone', !live);

    // Status (agent idle on a long command shows as "Waiting on shell", same as in office).
    const wait = live ? shellWaitIn(a, this.ctx.store.snapshot?.agents ?? [], now) : null;
    const status = wait ? 'shell' : a.status;
    updateStatusDot(this.dot, status);
    setText(this.statusText, statusLabel(status));
    // Idle on a long command: "since" is command start (server status remains 'working').
    const since = wait?.foreground ? wait.since : a.statusSince;
    setText(this.statusSince, relativeTime(since, now));
    setTitle(this.statusSince, tr('Since {0}', [formatClock(since)]));
    const following = this.ctx.world.getOptions().followSelected;
    setAttr(this.followBtn, 'aria-pressed', String(following));
    this.followBtn.classList.toggle('is-on', following);
    // Antigravity worker: no conversation to open or messages; in manual mode, "Send a job" (local only). An Antigravity
    // boss has its terminal (where you talk to it).
    const agy = providerOf(a) === 'agy';
    // A worker's terminal opens from its "Terminal" section (watch-only), not from here.
    if ((agy && !a.boss) || workerSession) {
      setHidden(this.termBtn, true);
      setHidden(this.termWhy, true);
    } else {
      setHidden(this.termBtn, false);
      this.renderTerminalButton(!!live);
    }
    const here = !!live && !!this.ctx.store.snapshot?.meta.terminal && !access().remote && !this.ctx.store.mock;
    // "Send a job": every registered worker (through its terminal; an older server without terminals: agy-ask).
    const manual = here && !!worker && !a.boss;
    setHidden(this.agySec.el, !manual);
    const local = agy && here && !a.boss;
    setHidden(this.agyDefaultsSec.el, !local);
    if (local) this.agyDefaults.render(a);
    if (manual) this.agyPanel.render(a.id, a.status, workerSession?.worker);
    setHidden(this.workerTermSec.el, !here || !workerSession?.ptyId);
    if (here && workerSession) this.workerTerm.render(a, workerSession, team?.jobs?.find((j) => j.id === workerSession.job) ?? team?.jobs?.find((j) => j.worker === workerSession.worker));
    setHidden(this.agyProgressSec.el, !agy || !a.progress);
    if (agy && a.progress) this.agyProgress.render(a.progress);

    // Alert.
    const waiting = a.status === 'waiting' && !!live;
    this.perm.render(live);
    setHidden(this.alert, !waiting || this.perm.visible);
    if (waiting) {
      const accName = account?.name ?? a.account;
      // Codex: "Go to Codex (Account X)"; avoids repeating when account is already named "Codex".
      const where = codex ? tr('Codex{0}', [/codex/i.test(accName) ? '' : ` (${accName})`]) : tr('the {0} terminal', [accName]);
      setText(this.alertText, tr('Go to {0} in {1} to reply{2}', [where, room?.name ?? tr('your project'), a.waitingFor ? `: ${a.waitingFor}` : '.']));
    }
    // AskUserQuestion questions (read-only): Codex does not ask questions from the office.
    const asking = waiting && !codex && a.activity?.kind === 'ask' ? a.activity : undefined;
    this.renderQuestions(asking);
    // Without request in office: can answer from here with plugin (local-only check, like the card). Codex
    // does not answer questions from the office.
    const answerable =
      !codex && !!asking?.questions?.length && !this.perm.visible && !this.ctx.store.mock && !!this.ctx.store.snapshot?.meta.terminal && access().permissions;
    setHidden(this.alertAnswerHint, !answerable);

    // Waiting on shell.
    setHidden(this.shellBox, !wait);
    if (wait) {
      setText(this.shellText, shellBoxText(wait));
      const stage = shellStage(now - wait.since);
      setText(this.shellMood, `${stage.emoji} ${stage.text}`);
      setText(this.shellNext, stage.nextIn !== null ? tr('Next phase in {0}', [formatDuration(Math.max(1_000, stage.nextIn))]) : '');
      setHidden(this.shellNext, stage.nextIn === null);
      setTitle(this.shellNext, tr('Time left until the character changes what it does while waiting (see Help)'));
    }
    // If agent has no shells of its own, show shells it is waiting for from a subagent.
    const own = live ? visibleShells(a, now) : [];
    const jobs = own.length || !wait ? own : wait.jobs;
    setHidden(this.shellsSec.el, jobs.length === 0);
    setText(this.shellsSec.extra, jobs.length > 1 ? String(jobs.length) : '');
    this.shells.sync(jobs);

    // Current activity.
    const act = a.activity;
    setText(this.actIcon, act?.icon ?? '·');
    setText(this.actText, act?.text ?? activityFallback(a));
    // Duration is only included when text doesn't already have it ("Finished in 33s" already has it).
    const showDuration = !!act?.durationMs && act.kind !== 'done' && !/\d\s?(?:ms|s|min|h)\b/.test(act.text);
    setText(this.actTime, act ? `${relativeTime(act.at, now)}${showDuration ? ` · ${tr('took {0}', [formatDuration(act.durationMs!)])}` : ''}` : '');
    this.actText.classList.toggle('is-error', !!act?.error);
    const detail = act?.detail ?? '';
    setHidden(this.actDetails, !detail);
    setText(this.actDetail, detail);

    // Send message: only for present main agents (feature enabled and local page; without plugin, hint).
    // (a worker takes jobs, not messages)
    const composer = agy || workerSession ? 'off' : this.composer.render(live, this.id);
    setHidden(this.msgSec.el, composer === 'off');
    setText(this.msgSec.title, a.boss ? tr('Orders for the boss') : tr('Send message'));
    setHidden(this.orders, !a.boss || !live || composer !== 'ready');
    // Model, effort and plan mode: Claude Code sessions whose plugin is connected (same lock as messages).
    const controls = composer === 'ready' && (a.provider ?? 'claude') === 'claude';
    setHidden(this.sessionSec.el, !controls);
    if (controls) this.sessionCtl.render(a);

    // Social life (personality, wallet, circles): only for agents currently in the office.
    if (live) this.social.render(a.id, now);
    else setHidden(this.social.el, true);

    // Tasks.
    const tp = taskProgress(a.tasks);
    setHidden(this.tasksSec.el, a.tasks.length === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(a.tasks);

    // Team: subagents (main) or parent (sub).
    if (a.kind === 'main') {
      const subs = sortByUrgency((this.ctx.store.snapshot?.agents ?? []).filter((s) => s.parentId === a.id));
      setText(this.teamSec.title, tr('Subagents'));
      setText(this.teamSec.extra, subs.length ? String(subs.length) : '');
      setText(this.teamEmpty, a.stats.subagents ? tr('None active right now ({0} in this session).', [plural(a.stats.subagents, tr('launched'), tr('launched'))]) : tr('No subagents launched yet.'));
      setHidden(this.teamEmpty, subs.length > 0);
      this.team.sync(subs);
    } else {
      const parent = a.parentId ? this.ctx.agent(a.parentId) : undefined;
      setText(this.teamSec.title, tr('Main agent'));
      setText(this.teamSec.extra, '');
      setText(this.teamEmpty, tr('The main agent is no longer in the office.'));
      setHidden(this.teamEmpty, !!parent);
      this.team.sync(parent ? [parent] : []);
    }

    // Timeline (newest first). In replay, nothing after the playback timestamp.
    const until = this.historyUntil();
    this.history = mergeHistory(this.history, a.recent, 200, until);
    const items = this.history.slice(-this.timelineShown).reverse();
    const hiddenCount = Math.max(0, this.history.length - this.timelineShown);
    setHidden(this.timelineMore, hiddenCount === 0);
    setText(this.timelineMore, tr('Show {0} more', [Math.min(TIMELINE_STEP, hiddenCount)]));
    setHidden(this.timelineLess, this.timelineShown <= TIMELINE_STEP || this.history.length <= TIMELINE_STEP);
    this.timeline.sync(items);
    setText(this.timelineSec.extra, this.history.length ? String(this.history.length) : '');

    this.renderStats(a, now);

    // Codex: how to get live view and approvals here (server doesn't yet say if its hooks are on).
    setHidden(this.codexHint, !codex || a.kind !== 'main' || !live || this.ctx.store.replaying);
  }

  /** Lists pending questions with options, read-only (without office request, answer in Claude Code). */
  private renderQuestions(act: Activity | undefined): void {
    const qs = act?.questions ?? [];
    setHidden(this.alertQuestions, qs.length === 0);
    const key = qs.length ? `${act!.id}|${qs.length}` : '';
    if (key === this.alertQuestionsKey) return;
    this.alertQuestionsKey = key;
    this.alertQuestions.replaceChildren(
      ...qs.map((q) =>
        h(
          'div',
          { class: 'ui-ask__q' },
          q.header ? h('span', { class: 'ui-ask__tag', text: q.header }) : null,
          h('p', { class: 'ui-ask__question', text: q.question }),
          q.multiSelect ? h('p', { class: 'ui-ask__hint', text: tr('You can pick more than one') }) : null,
          h(
            'ol',
            { class: 'ui-ask__opts' },
            ...q.options.map((o) =>
              h('li', {}, h('strong', { text: o.label }), o.description ? h('span', { class: 'ui-ask__desc', text: o.description }) : null),
            ),
          ),
        ),
      ),
    );
  }

  private renderTerminalButton(live: boolean, provider = providerOf(this.last)): void {
    const router = this.ctx.terminals;
    const available = (router ? router.available : !!this.ctx.store.snapshot?.meta.terminal) && access().terminal;
    const open = (router ? router.openAgentId : this.terminal.agentId) === this.id;
    // Interactive: Claude Code runs here (pty) or in another terminal and can be taken over.
    const readOnly = !!this.ctx.store.snapshot?.meta.terminal;
    const kind = !this.id ? '' : router?.interactive(this.id) ? 'interativo' : !readOnly && this.pty.enabled && ptyControllable(this.last) ? 'em outro terminal' : 'ao vivo';
    setText(this.termRo, kind === 'interativo' ? tr('interactive') : kind === 'ao vivo' ? tr('live') : kind ? tr('in another terminal') : '');
    // aria-disabled (not disabled): button remains focusable and tooltip reason appears on hover.
    const enabled = open || (available && live);
    if (enabled) setHidden(this.termWhy, true);
    setAttr(this.termBtn, 'aria-disabled', enabled ? null : 'true');
    this.termBtn.classList.toggle('is-disabled', !enabled);
    setAttr(this.termBtn, 'aria-pressed', String(open));
    this.termBtn.classList.toggle('is-on', open);
    setText(this.termLabel, open ? tr('Close terminal') : tr('Open terminal'));
    setTitle(
      this.termBtn,
      open
        ? tr('Close the terminal (T)')
        : !available
          ? this.ctx.store.replaying
            ? tr('No terminal in timelapse: the conversation is the current one, not the one from the replayed moment.')
            : this.ctx.store.snapshot?.meta.terminal && access().remote
              ? tr("The terminal isn't enabled for remote access (HABBLAUD_REMOTE_ALLOW).")
              : TERMINAL_UNAVAILABLE_HINT
          : !live
            ? tr('The agent has already left the office.')
            : kind === 'ao vivo'
              ? tr("View this session's conversation as in {0}, live{1} (T)", [
                  provider === 'codex' ? 'Codex' : tr('the Claude Code terminal'),
                  this.pty.enabled && ptyControllable(this.last) ? tr('; "Take over here" continues it here') : '',
                ])
              : kind === 'interativo'
                ? tr("Open this session's terminal, which runs here in Habblaud (T)")
                : tr('Open the terminal: the session runs in another terminal; you can take over here (T)'),
    );
  }

  private renderStats(a: AgentInfo, now: number): void {
    const s = a.stats;
    const st = this.stats;
    st.set('tools', formatInt(s.toolCalls));
    st.set('tokensIn', formatTokens(s.tokensIn));
    st.set('tokensOut', formatTokens(s.tokensOut));
    st.set('cost', s.costUSD !== undefined ? formatUSD(s.costUSD) : null);
    const codex = providerOf(a) === 'codex';
    const hasLines = s.linesAdded !== undefined || s.linesRemoved !== undefined;
    st.show('lines', hasLines);
    setText(this.linesPlus, `+${formatInt(s.linesAdded ?? 0)}`);
    setText(this.linesMinus, `−${formatInt(s.linesRemoved ?? 0)}`);
    st.set('subs', a.kind === 'main' ? formatInt(s.subagents) : null);
    st.set('model', prettyModel(a.model));
    st.set('effort', a.effort ?? null);
    st.set('branch', a.gitBranch ?? null);
    // Codex: approval policy (when server sends it) instead of Claude Code permission mode.
    st.label('perm', codex ? tr('Approvals') : tr('Permissions'));
    st.set('perm', a.kind !== 'main' ? null : codex ? (a.permissionMode ? codexApprovalLabel(a.permissionMode) : null) : permissionLabel(a.permissionMode));

    setText(this.sessionValue, a.sessionId);
    setTitle(this.sessionValue, a.sessionId);
    st.set('start', formatDateTime(a.startedAt));
    st.set('duration', formatDuration(now - a.startedAt));
    st.set('bg', a.background ? tr('In the background') : null);
  }
}

type StatKey = 'tools' | 'tokensIn' | 'tokensOut' | 'cost' | 'lines' | 'subs' | 'model' | 'effort' | 'branch' | 'perm' | 'session' | 'start' | 'duration' | 'bg';

/** Key/value list of fixed rows: each row is created once and only updates text/visibility. */
class KvList<K extends string> {
  readonly el: HTMLElement;
  private rows = new Map<K, { dt: HTMLElement; dd: HTMLElement }>();

  constructor(defs: readonly [K, string, Node?][]) {
    this.el = h('dl', { class: 'ui-kv ui-stats' });
    for (const [key, label, content] of defs) {
      const dt = h('dt', { text: label });
      const dd = h('dd');
      if (content) dd.append(content);
      this.rows.set(key, { dt, dd });
      this.el.append(dt, dd);
    }
  }

  /** Changes row label (e.g. "Approvals" in Codex). */
  label(key: K, text: string): void {
    setText(this.rows.get(key)!.dt, text);
  }

  /** Sets row text; `null` hides the row. */
  set(key: K, value: string | null): void {
    const r = this.rows.get(key)!;
    this.show(key, value !== null);
    if (value !== null) setText(r.dd, value);
  }

  show(key: K, visible: boolean): void {
    const r = this.rows.get(key)!;
    setHidden(r.dt, !visible);
    setHidden(r.dd, !visible);
  }
}

// ---------------------------------------------------------------- room view

class RoomView {
  readonly el: HTMLElement;
  private id = '';
  private last: RoomInfo | null = null;
  private swatch: HTMLElement;
  private name: HTMLElement;
  private renameBtn: HTMLButtonElement;
  private path: HTMLElement;
  private gone: HTMLElement;
  private accs: KeyedList<string>;
  private agents: KeyedList<AgentInfo>;
  private agentsSec: ReturnType<typeof section>;
  private agentsEmpty: HTMLElement;
  private tasksSec: ReturnType<typeof section>;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<{ task: TaskItem; owner: string; key: string }>;
  private feed: KeyedList<FeedItem>;
  private feedSec: ReturnType<typeof section>;
  private newBtn: HTMLButtonElement;
  private newMsg: HTMLElement;

  constructor(
    private ctx: UiContext,
    private pty: PtyControl,
  ) {
    this.newBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('New session'), title: tr('Opens a new Claude Code in this folder, in an interactive terminal'), on: { click: () => this.newSession() } });
    this.newMsg = h('p', { class: 'ui-actions__msg is-error', role: 'status', hidden: true });
    this.swatch = h('span', { class: 'ui-room-hero__swatch', attrs: { 'aria-hidden': 'true' } });
    this.name = h('h2', { class: 'ui-hero__name' });
    // Pencil: same field as right-click on room (ui/roomrename.ts), opened below name.
    this.renameBtn = iconButton(
      ICONS.pencil,
      tr('Rename room'),
      () => {
        const r = this.name.getBoundingClientRect();
        ctx.renameRoom?.(this.id, { x: r.left, y: r.bottom + 6 });
      },
      'ui-icon-btn--sm ui-room-hero__rename',
    );
    this.path = h('span', { class: 'ui-room-hero__path' });
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: tr('Move the camera to the room'), on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: tr('Center') }));
    this.gone = h('p', { class: 'ui-gone', text: tr('This room was closed: all agents have left.'), hidden: true });

    const accsEl = h('div', { class: 'ui-acc-list' });
    this.accs = new KeyedList<string>(accsEl, {
      animate: false,
      key: (id) => id,
      create: () => h('span', { class: 'ui-acc-item' }, createAccountChip('sm'), h('span')),
      update: (el, id) => {
        const acc = ctx.account(id);
        updateAccountChip(el.firstElementChild as HTMLElement, acc, id);
        // "Account C · dev@x.com"; in Codex, "Codex · Team plan".
        setText(el.lastElementChild!, accountChipLabel(acc, id, accountProvider(acc, id)).replace(/ \((.+)\)$/, ' · $1'));
      },
    });

    const agentsList = h('div', { class: 'ui-team' });
    this.agentsEmpty = h('p', { class: 'ui-muted ui-small', text: tr('No one in the room right now.') });
    this.agentsSec = section(tr('Agents'), agentsList, this.agentsEmpty);
    this.agents = new KeyedList<AgentInfo>(agentsList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    this.tasksBar = createProgress(tr('Room task progress'));
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section(tr('Tasks'), this.tasksBar, tasksList);
    this.tasks = new KeyedList(tasksList, { key: (t) => t.key, create: createTaskItem, update: (li, t) => updateTaskItem(li, t.task, t.owner) });

    const feedList = h('ol', { class: 'ui-timeline' });
    this.feedSec = section(tr('Recent activity'), feedList);
    this.feed = new KeyedList<FeedItem>(feedList, { key: (f) => f.id, create: createTimelineItem, update: (li, f) => updateTimelineItem(li, f.activity, ctx.now(), f.agentName) });

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-room-view' },
      h(
        'div',
        { class: 'ui-room-hero' },
        this.swatch,
        h('div', { class: 'ui-hero__text' }, h('div', { class: 'ui-room-hero__title' }, this.name, this.renameBtn), h('span', { class: 'ui-copy-row' }, this.path, copyButton(() => this.last?.path ?? '', tr('Copy path')))),
      ),
      this.gone,
      h('div', { class: 'ui-status' }, accsEl, h('span', { class: 'ui-status__actions' }, this.newBtn, centerBtn)),
      this.newMsg,
      this.agentsSec.el,
      this.tasksSec.el,
      this.feedSec.el,
    );
  }

  get roomId(): string {
    return this.id;
  }

  /** New session in room folder, using account of someone in it (or default). */
  private newSession(): void {
    const r = this.last;
    if (!r) return;
    // Claude Code accounts only (neither Codex nor demo); if none in room, server uses default.
    const account = (this.ctx.store.snapshot?.agents ?? []).find((a) => a.roomId === r.id && ptyControllable(a))?.account;
    setHidden(this.newMsg, true);
    this.pty.newSession(r.path, account).catch((err: Error) => {
      setText(this.newMsg, tr("Didn't work: {0}", [err.message]));
      setHidden(this.newMsg, false);
    });
  }

  open(id: string): void {
    if (this.id === id) return;
    this.id = id;
    this.last = null;
    this.agents.clear();
    this.tasks.clear();
    this.feed.clear();
  }

  render(): void {
    const live = this.ctx.store.room(this.id);
    if (live) this.last = live;
    const r = this.last;
    if (!r) return;
    setText(this.name, r.name);
    setText(this.path, shortPath(r.path));
    setTitle(this.path, r.path);
    try {
      setStyleVar(this.swatch, '--room', roomTheme(r.seed).accent);
    } catch {
      // Without theme: default color.
    }
    setHidden(this.gone, !!live);
    setHidden(this.renameBtn, !live || !canRenameRoom(this.ctx, r.id));
    setHidden(this.newBtn, !this.pty.enabled);

    const snap = this.ctx.store.snapshot;
    const agents = (snap?.agents ?? []).filter((a) => a.roomId === r.id);
    this.accs.sync(accountsOf(agents, snap?.accounts ?? []));
    const ordered = sortByUrgency(agents);
    setText(this.agentsSec.extra, agents.length ? String(agents.length) : '');
    setHidden(this.agentsEmpty, agents.length > 0);
    this.agents.sync(ordered);

    const tp = aggregateTasks(agents);
    setHidden(this.tasksSec.el, tp.total === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(agents.flatMap((a) => a.tasks.map((task) => ({ task, owner: a.name, key: `${a.id}#${task.id}` }))));

    const feed = this.ctx.store.feed.filter((f) => f.roomId === r.id).slice(-ROOM_FEED_LIMIT).reverse();
    setHidden(this.feedSec.el, feed.length === 0);
    this.feed.sync(feed);
  }
}

// ---------------------------------------------------------------- drawer

export class Drawer implements UiComponent {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private agentView: AgentView;
  private roomView: RoomView;
  private mode: 'agent' | 'room' | null = null;
  private heading: HTMLElement;
  private movable: Movable;
  /** Notified when drawer is detached or docked (office free area changes). */
  onLayoutChange: (() => void) | null = null;

  constructor(
    private ctx: UiContext,
    terminal: TerminalControl,
    pty: PtyControl,
  ) {
    this.agentView = new AgentView(ctx, terminal, pty);
    this.roomView = new RoomView(ctx, pty);
    this.heading = h('span', { class: 'ui-drawer__kind' });
    const close = iconButton(ICONS.close, tr('Close details (Esc)'), () => ctx.select(null));
    this.body = h('div', { class: 'ui-drawer__body' });
    const bar = h('div', { class: 'ui-drawer__bar' }, this.heading, close);
    this.el = h(
      'aside',
      { class: 'ui-panel ui-drawer', attrs: { 'aria-label': tr('Details'), id: 'ui-drawer', 'aria-hidden': 'true' } },
      bar,
      this.body,
    );
    // Dragging by bar detaches drawer: floating, it no longer covers office side.
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.drawer', enabled: () => !ctx.isNarrow(), onChange: () => this.onLayoutChange?.() });
    this.el.inert = true;
  }

  get isOpen(): boolean {
    return this.mode !== null;
  }

  /** Detached from side (dragged by the bar). */
  get floating(): boolean {
    return this.movable.floating;
  }

  toggleFollow(): void {
    if (this.mode === 'agent') this.agentView.toggleFollow();
  }

  render(): void {
    const sel = this.ctx.selection();
    const mode = sel?.type ?? null;
    if (mode !== this.mode) {
      // Drawer closed or deselected agent: editor closes, and reopening starts from current agent state.
      if (this.mode === 'agent') this.agentView.character.close();
      this.mode = mode;
      this.body.replaceChildren(...(mode === 'agent' ? [this.agentView.el] : mode === 'room' ? [this.roomView.el] : []));
      this.body.scrollTop = 0;
      this.el.classList.toggle('is-open', mode !== null);
      setAttr(this.el, 'aria-hidden', mode ? 'false' : 'true');
      this.el.inert = mode === null;
    }
    if (sel?.type === 'agent') {
      if (this.agentView.agentId !== sel.id) this.body.scrollTop = 0;
      this.agentView.open(sel.id);
      setText(this.heading, this.ctx.agent(sel.id)?.kind === 'sub' ? tr('Subagent') : tr('Agent'));
      this.agentView.render();
    } else if (sel?.type === 'room') {
      if (this.roomView.roomId !== sel.id) this.body.scrollTop = 0;
      this.roomView.open(sel.id);
      setText(this.heading, tr('Room'));
      this.roomView.render();
    }
  }
}
