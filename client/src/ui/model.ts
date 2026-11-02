// UI presentation model: rooms -> agents -> subagents grouping, filters, counters, and labels.
// Pure functions (no DOM), tested in ui/model.test.ts.
import type { AccountInfo, Activity, AgentInfo, AgentStatus, OfficeInfo, OfficeSnapshot, RoomInfo, ShellJob, TaskItem, TeamInfo } from '../../../shared/types';
import { formatElapsed, normalizeSearch } from './format';
import { tr } from '../../../shared/i18n';
import { workerOfAgent } from './workers-api';
import { agentOfficeId, officeBoss, teamOffices } from './offices';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: tr('Working'),
  waiting: tr('Needs you'),
  shell: tr('Waiting on shell'),
  idle: tr('Idle'),
  done: tr('Done'),
  offline: tr('Leaving'),
};

/** Urgency order (lower = more urgent), used to highlight agents needing attention. */
const STATUS_URGENCY: Record<AgentStatus, number> = { waiting: 0, shell: 1, working: 2, idle: 3, done: 4, offline: 5 };

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABEL[status];
}

/** Fallback activity text when the agent has none yet (e.g. newly opened session, no prompt). */
export function activityFallback(agent: Pick<AgentInfo, 'status' | 'waitingFor'>): string {
  switch (agent.status) {
    case 'working':
      return tr('Working…');
    case 'waiting':
      return agent.waitingFor ? tr('Needs you: {0}', [agent.waitingFor]) : tr('Needs you');
    case 'shell':
      return tr('Waiting for the shell to finish');
    case 'done':
      return tr('Finished the task');
    case 'offline':
      return tr('Leaving the office');
    default:
      return tr('Waiting for instructions');
  }
}

/** Role badge: "Main agent" or the subagent's role ("Explore", "Plan"...). */
export function roleLabel(agent: Pick<AgentInfo, 'kind' | 'role' | 'boss'>): string {
  if (agent.boss) return tr('👑 Boss of the workers');
  if (agent.kind === 'main') return agent.role || tr('Main agent');
  return agent.role || tr('Subagent');
}

/** Agent still "present" (not leaving). */
export function isPresent(agent: Pick<AgentInfo, 'status'>): boolean {
  return agent.status !== 'offline';
}

export interface Counters {
  rooms: number;
  /** Present agents (main + subagents, except those leaving). */
  agents: number;
  /** Agents processing a request (excluding those waiting on a long command). */
  working: number;
  /** Active subagents (not completed or leaving). */
  subagents: number;
  waiting: number;
  /** Shells any agent is waiting to finish (background and long foreground commands). */
  shells: number;
}

/** `now` (server clock) determines when a foreground command counts as waiting. */
export function computeCounters(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null, now = Date.now()): Counters {
  const c: Counters = { rooms: 0, agents: 0, working: 0, subagents: 0, waiting: 0, shells: 0 };
  if (!snap) return c;
  c.rooms = snap.rooms.length;
  for (const a of snap.agents) {
    if (!isPresent(a)) continue;
    c.agents++;
    const wait = shellWaitIn(a, snap.agents, now);
    if (wait) c.shells += Math.max(1, wait.jobs.length);
    else if (a.status === 'working') c.working++;
    if (a.status === 'waiting') c.waiting++;
    if (a.kind === 'sub' && a.status !== 'done') c.subagents++;
  }
  return c;
}

/** Agents waiting on user, from longest-waiting to most recent. */
export function waitingAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.status === 'waiting').sort((a, b) => a.statusSince - b.statusSince);
}

// ---------------------------------------------------------------- waiting on shell

/** A foreground command only counts as "waiting on shell" after this duration (same threshold as world). */
export const FOREGROUND_WAIT_MS = 10_000;
/** In drawer, foreground commands only appear after this duration (fast commands won't flicker list). */
export const FOREGROUND_SHOW_MS = 2_000;

export interface ShellWait {
  /** Commands the agent is waiting on, oldest to newest. */
  jobs: ShellJob[];
  /** Command driving wait time and stage (oldest shell); absent if server doesn't know commands yet. */
  main?: ShellJob;
  /** Waiting since (epoch ms). */
  since: number;
  /** true = blocked on long foreground command (status 'working'); false = finished turn (status 'shell'). */
  foreground: boolean;
}

const byStart = (a: ShellJob, b: ShellJob) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Is the agent waiting on any shell? Applies to 'shell' status (finished turn with background shells)
 * and 'working' stuck on foreground command for over FOREGROUND_WAIT_MS. Returns null otherwise.
 * Time tracked from oldest shell (Bash); monitors only count if there are no shells.
 */
export function shellWait(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): ShellWait | null {
  const all = agent.shells ?? [];
  let jobs: ShellJob[];
  if (agent.status === 'shell') jobs = all.slice().sort(byStart);
  else if (agent.status === 'working') jobs = all.filter((j) => !j.background && now - j.startedAt >= FOREGROUND_WAIT_MS).sort(byStart);
  else return null;
  if (agent.status === 'working' && jobs.length === 0) return null;
  const main = jobs.find((j) => j.kind === 'shell') ?? jobs[0];
  return { jobs, main, since: Math.min(main?.startedAt ?? agent.statusSince, now), foreground: agent.status === 'working' };
}

/** Background shells spawned by an agent's subagents (and their subagents). */
function descendantShells(id: string, agents: readonly AgentInfo[]): ShellJob[] {
  const out: ShellJob[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const a of agents) {
      if (a.parentId !== parent || seen.has(a.id)) continue;
      seen.add(a.id);
      queue.push(a.id);
      for (const j of a.shells ?? []) if (j.background) out.push(j);
    }
  }
  return out;
}

/**
 * Like `shellWait`, checking the whole office: an agent in 'shell' with no known shells of its own
 * may be waiting on a command a subagent left running in background (server does the same in bubble).
 */
export function shellWaitIn(agent: AgentInfo, agents: readonly AgentInfo[], now: number): ShellWait | null {
  if (agent.status === 'shell' && !agent.shells?.length) {
    const inherited = descendantShells(agent.id, agents);
    if (inherited.length) return shellWait({ status: agent.status, statusSince: agent.statusSince, shells: inherited }, now);
  }
  return shellWait(agent, now);
}

/** Display status in UI: agents stuck waiting on long commands appear as "Waiting on shell". */
export function displayStatus(agent: Pick<AgentInfo, 'status' | 'shells' | 'statusSince'>, now: number): AgentStatus {
  return shellWait(agent, now) ? 'shell' : agent.status;
}

/** Commands listed in drawer ("Running shells"): all except recently started foreground commands. */
export function visibleShells(agent: Pick<AgentInfo, 'shells'>, now: number): ShellJob[] {
  return (agent.shells ?? []).filter((j) => j.background || j.kind === 'monitor' || now - j.startedAt >= FOREGROUND_SHOW_MS).sort(byStart);
}

/** Agents waiting on shells, from longest-waiting to most recent ("⏳ N shells" button). */
export function shellWaitingAgents(agents: readonly AgentInfo[], now: number): AgentInfo[] {
  return agents
    .filter((a) => isPresent(a))
    .map((a) => ({ a, w: shellWaitIn(a, agents, now) }))
    .filter((x): x is { a: AgentInfo; w: ShellWait } => !!x.w)
    .sort((x, y) => x.w.since - y.w.since || byArrival(x.a, y.a))
    .map((x) => x.a);
}

/** Is there any running shell? (UI updates stopwatch every second if so.) */
export function hasRunningShells(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => isPresent(a) && (a.status === 'shell' || (a.shells?.length ?? 0) > 0));
}

/** Command type badge. */
export function shellKindLabel(job: Pick<ShellJob, 'kind' | 'background'>): string {
  if (job.kind === 'monitor') return 'monitor';
  return job.background ? tr('background') : tr('foreground');
}

export interface ShellLine {
  /** Main shell label (or generic text). */
  label: string;
  /** Stopwatch: "0:42", "12:31", "1:02:10". */
  time: string;
  /** "×2" when waiting on multiple commands; "" with just one. */
  count: string;
  /** Full sentence for tooltips and screen readers: "⏳ Run suite · 12:31 (2 shells)". */
  text: string;
}

/** Activity line when waiting on shell: "⏳ <label> · <time>" (and "×N" if multiple). */
export function shellLine(wait: ShellWait, now: number): ShellLine {
  const label = wait.main?.label?.trim() || (wait.foreground ? tr('Waiting for the command to finish') : tr('Waiting for the shell to finish'));
  const time = formatElapsed(now - wait.since);
  const n = wait.jobs.length;
  const count = n > 1 ? `×${n}` : '';
  return { label, time, count, text: `⏳ ${label} · ${time}${n > 1 ? ` (${n} shells)` : ''}` };
}

/** Text for "Waiting on shell" box. */
export function shellBoxText(wait: Pick<ShellWait, 'foreground' | 'jobs'>): string {
  if (wait.foreground) return tr('Stuck on a terminal command, waiting for it to finish to continue the turn.');
  const n = wait.jobs.length;
  return n > 1
    ? tr('Finished the turn and is waiting for {0} shells to finish. As each one finishes, the agent gets its result.', [n])
    : tr('Finished the turn and is waiting for the shell to finish. When it does, the agent gets the result.');
}

export type ShellStage = 'popcorn' | 'spin' | 'cobweb' | 'nap';

export interface ShellStageInfo {
  stage: ShellStage;
  /** Elapsed wait duration when stage begins (ms). */
  from: number;
  emoji: string;
  /** Short phrase describing what character is doing. */
  text: string;
  /** Help description. */
  help: string;
}

const MIN = 60_000;

/** Wait stages in the office ("comic escalation"), by age of oldest shell. */
export const SHELL_STAGES: readonly ShellStageInfo[] = [
  {
    stage: 'popcorn',
    from: 0,
    emoji: '🍿',
    text: tr('Eating popcorn and watching the terminal'),
    help: tr('Up to 3 min: leans back in the chair with a bucket of popcorn and watches the terminal like a movie.'),
  },
  {
    stage: 'spin',
    from: 3 * MIN,
    emoji: '🪑',
    text: tr('Out of popcorn: spinning in the chair'),
    help: tr('From 3 to 10 min: the popcorn runs out; arms crossed, fingers tapping and, now and then, a full spin in the chair.'),
  },
  {
    stage: 'cobweb',
    from: 10 * MIN,
    emoji: '🕸️',
    text: tr("There's a cobweb on the chair already"),
    help: tr('After 10 min: a cobweb appears on the chair (it grows after 20 min) and a yawn slips out.'),
  },
  {
    stage: 'nap',
    from: 25 * MIN,
    emoji: '😴',
    text: tr('Dozed off waiting on the shell'),
    help: tr('After 25 min: naps at the desk, covered in cobwebs.'),
  },
];

/** Wait stage for shell running for `ms`, and time until next stage (null on last). */
export function shellStage(ms: number): ShellStageInfo & { nextIn: number | null } {
  const v = Math.max(0, ms);
  let i = 0;
  while (i + 1 < SHELL_STAGES.length && v >= SHELL_STAGES[i + 1].from) i++;
  const next = SHELL_STAGES[i + 1];
  return { ...SHELL_STAGES[i], nextIn: next ? next.from - v : null };
}

/** Server marker for shell completion (Activity with tool 'ShellDone'; error = failed or interrupted). */
export function shellDoneKind(activity: Pick<Activity, 'tool' | 'error'> | undefined): 'ok' | 'fail' | null {
  if (activity?.tool !== 'ShellDone') return null;
  return activity.error ? 'fail' : 'ok';
}

export interface TaskProgress {
  completed: number;
  inProgress: number;
  total: number;
}

export function taskProgress(tasks: readonly Pick<TaskItem, 'status'>[]): TaskProgress {
  const p: TaskProgress = { completed: 0, inProgress: 0, total: tasks.length };
  for (const t of tasks) {
    if (t.status === 'completed') p.completed++;
    else if (t.status === 'in_progress') p.inProgress++;
  }
  return p;
}

/** Sums tasks across multiple agents (aggregated progress for a room). */
export function aggregateTasks(agents: readonly Pick<AgentInfo, 'tasks'>[]): TaskProgress {
  return taskProgress(agents.flatMap((a) => a.tasks));
}

// ---------------------------------------------------------------- grouping and filters

export interface AgentFilter {
  /** Free text: name, role, title, room, path, or account. */
  query: string;
  /** Hidden accounts (AccountInfo.id). */
  hiddenAccounts: ReadonlySet<string>;
}

export interface AgentNode {
  agent: AgentInfo;
  /** Visible subagents (after filters), ordered by arrival. */
  subs: AgentInfo[];
  /** Total present subagents in snapshot (filter-independent). */
  subTotal: number;
}

export interface RoomGroup {
  room: RoomInfo;
  /** Accounts present in room (ids, in snapshot `accounts` order). */
  accounts: string[];
  nodes: AgentNode[];
  /** All agents in the room (unfiltered). */
  agents: AgentInfo[];
  tasks: TaskProgress;
  /** How many agents in room match filter. */
  matches: number;
}

function accountText(account: AccountInfo | undefined): string {
  if (!account) return '';
  // Tool included in search: "codex" finds Codex agents.
  return [account.short, account.name, account.email ?? '', account.id, account.provider === 'codex' ? 'Codex' : ''].join(' ');
}

/** True if agent matches text search (case- and accent-insensitive). */
export function matchesQuery(agent: AgentInfo, room: RoomInfo | undefined, account: AccountInfo | undefined, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(
    [
      agent.name,
      roleLabel(agent),
      agent.title ?? '',
      room?.name ?? '',
      room?.path ?? '',
      accountText(account),
      agent.activity?.text ?? '',
      // Agents waiting on a shell also match search for "shell" (or command label).
      agent.status === 'shell' ? STATUS_LABEL.shell : '',
      ...(agent.shells ?? []).map((j) => `shell ${j.label}`),
    ].join(' \u0001 '),
  );
  return q.split(/\s+/).every((term) => hay.includes(term));
}

const byArrival = (a: AgentInfo, b: AgentInfo) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Groups snapshot into rooms (ordered by slot) -> main agents -> subagents.
 * Subagents whose parent is not in the same room become top-level items.
 * With filter: main agent appears if it or a subagent matches; if main matches, all subs appear.
 * Rooms with no visible agents are omitted (unless no filter active).
 */
export function groupRooms(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'> | null, filter?: AgentFilter): RoomGroup[] {
  if (!snap) return [];
  const accounts = new Map(snap.accounts.map((a) => [a.id, a]));
  const accountOrder = new Map(snap.accounts.map((a, i) => [a.id, i]));
  const query = filter?.query.trim() ?? '';
  const hidden = filter?.hiddenAccounts ?? new Set<string>();
  const filtering = query.length > 0 || hidden.size > 0;

  const byRoom = new Map<string, AgentInfo[]>();
  for (const a of snap.agents) {
    let list = byRoom.get(a.roomId);
    if (!list) byRoom.set(a.roomId, (list = []));
    list.push(a);
  }

  const groups: RoomGroup[] = [];
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const agents = (byRoom.get(room.id) ?? []).slice().sort(byArrival);
    const visible = (a: AgentInfo) => !hidden.has(a.account) && matchesQuery(a, room, accounts.get(a.account), query);
    const ids = new Set(agents.map((a) => a.id));
    const subsOf = new Map<string, AgentInfo[]>();
    const top: AgentInfo[] = [];
    for (const a of agents) {
      if (a.kind === 'sub' && a.parentId && ids.has(a.parentId)) {
        let list = subsOf.get(a.parentId);
        if (!list) subsOf.set(a.parentId, (list = []));
        list.push(a);
      } else {
        top.push(a);
      }
    }

    const nodes: AgentNode[] = [];
    let matches = 0;
    for (const a of top) {
      const subs = subsOf.get(a.id) ?? [];
      const selfVisible = visible(a);
      const visibleSubs = selfVisible ? subs.filter((s) => !hidden.has(s.account)) : subs.filter(visible);
      if (!selfVisible && visibleSubs.length === 0) continue;
      matches += (selfVisible ? 1 : 0) + visibleSubs.length;
      nodes.push({ agent: a, subs: visibleSubs, subTotal: subs.length });
    }
    if (filtering && nodes.length === 0) continue;

    const present = [...new Set(agents.map((a) => a.account))].sort((x, y) => (accountOrder.get(x) ?? 99) - (accountOrder.get(y) ?? 99));
    groups.push({ room, accounts: present, nodes, agents, tasks: aggregateTasks(agents), matches });
  }
  return groups;
}

/**
 * Sidebar groups by role: the one boss (orchestrator), the Antigravity accounts registered as workers (team.json), and
 * "others" (every other session: a boss that stepped down, a Claude session asking something on the side, Codex).
 */
export type RoleKey = 'boss' | 'workers' | 'others';
export const ROLE_KEYS: readonly RoleKey[] = ['boss', 'workers', 'others'];

export interface RoleGroup {
  key: RoleKey;
  nodes: AgentNode[];
  /** Agents of the group still in the office (main agents, unfiltered by subagents). */
  present: number;
}

/** Who is boss and who are workers in the office shown (ui/offices.ts); absent = the old single team. */
export interface RoleScope {
  bossId?: string;
  workers: readonly string[];
  /** The office shown (OfficeInfo.id): the sidebar lists the characters of its building only (searches find all). */
  office?: string;
}

/** The scope of an office: its boss character, its workers and its building. */
export function roleScope(snap: Pick<OfficeSnapshot, 'agents' | 'team'> | null | undefined, office: OfficeInfo | undefined): RoleScope | undefined {
  if (!office) return undefined;
  return { bossId: officeBoss(snap, office)?.id ?? office.pendingBoss, workers: office.workers, office: office.id };
}

/** The character is drawn in the building of the scope's office (no scope or no office: everyone is). */
function inScopeBuilding(snap: Pick<OfficeSnapshot, 'agents'> | null | undefined, team: Parameters<typeof teamOffices>[0], a: Pick<AgentInfo, 'office' | 'parentId'>, scope: RoleScope | undefined): boolean {
  if (!scope?.office) return true;
  return agentOfficeId(snap, a, teamOffices(team)) === scope.office;
}

/**
 * Group of an agent. Workers = the characters of registered workers (snapshot.team: their terminal sessions, or the
 * Antigravity profiles in `workers`; without a team every Antigravity worker). `pendingBoss` = the session opened with
 * "＋ Boss", a boss before the server crowns it. With a `scope` (an office): its boss and its workers only; the
 * bosses and workers of the other offices go to Others.
 */
export function roleKey(
  a: Pick<AgentInfo, 'id' | 'boss' | 'provider' | 'office' | 'parentId'>,
  team?: Pick<TeamInfo, 'workers' | 'pendingBoss' | 'sessions' | 'offices'>,
  scope?: RoleScope,
  snap?: Pick<OfficeSnapshot, 'agents' | 'team'> | null,
): RoleKey {
  if (scope) {
    if (a.id === scope.bossId) return 'boss';
    // a character of another office's building (found by a search) is not this office's boss or worker
    if (!inScopeBuilding(snap, team, a, scope)) return 'others';
    const w = workerOfAgent(team, a);
    return w && scope.workers.includes(w) ? 'workers' : 'others';
  }
  if (a.boss || (team?.pendingBoss && a.id === team.pendingBoss)) return 'boss';
  return workerOfAgent(team, a) ? 'workers' : 'others';
}

/**
 * The sidebar by role instead of by folder: the same nodes as groupRooms (filters and subagents under their main
 * agent), regrouped. Boss and Workers are always there (empty = nobody yet, with their ＋); Others only when it has
 * someone. Inside a group: room order, then arrival. `scope`: the office shown (roleScope).
 */
export function groupRoles(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts' | 'team'> | null, filter?: AgentFilter, scope?: RoleScope): RoleGroup[] {
  if (!snap) return [];
  const byKey = new Map<RoleKey, AgentNode[]>(ROLE_KEYS.map((k) => [k, []]));
  // Several offices: the building of the office shown; a search looks in every building (a hit elsewhere switches the tab).
  const everywhere = !!filter?.query.trim();
  for (const g of groupRooms(snap, filter)) {
    for (const n of g.nodes) {
      if (!everywhere && !inScopeBuilding(snap, snap.team, n.agent, scope)) continue;
      byKey.get(roleKey(n.agent, snap.team, scope, snap))!.push(n);
    }
  }
  return ROLE_KEYS.flatMap((key) => {
    const nodes = byKey.get(key)!;
    if (!nodes.length && key === 'others') return [];
    return [{ key, nodes, present: nodes.filter((n) => n.agent.status !== 'offline').length }];
  });
}

/** Distinct accounts present in agent list, in snapshot account order. */
export function accountsOf(agents: readonly Pick<AgentInfo, 'account'>[], accounts: readonly Pick<AccountInfo, 'id'>[]): string[] {
  const present = new Set(agents.map((a) => a.account));
  const ordered = accounts.map((a) => a.id).filter((id) => present.has(id));
  for (const id of present) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** Sorts by urgency then arrival (for subagent lists in drawer). */
export function sortByUrgency(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.slice().sort((a, b) => STATUS_URGENCY[a.status] - STATUS_URGENCY[b.status] || byArrival(a, b));
}

/** Shell shortcuts for empty state text: ["c", "d"] -> "shortcuts c or d". */
export function shortcutHint(accounts: readonly Pick<AccountInfo, 'short'>[]): string {
  const keys = accounts.map((a) => a.short.toLowerCase()).filter((s) => /^[a-z0-9]{1,3}$/.test(s));
  if (keys.length === 0) return '';
  if (keys.length === 1) return tr('shortcut {0}', [keys[0]]);
  return tr('shortcuts {0} or {1}', [keys.slice(0, -1).join(', '), keys[keys.length - 1]]);
}

/**
 * Merges long history (server) with recent activities, deduplicated, oldest to newest.
 * `until` (replay timestamp) discards subsequent events — rewinding won't show future in drawer.
 */
export function mergeHistory<T extends { id: string; at: number }>(history: readonly T[], recent: readonly T[], limit = 200, until?: number): T[] {
  const seen = new Map<string, T>();
  const keep = (a: T) => until === undefined || a.at <= until;
  for (const a of history) if (keep(a)) seen.set(a.id, a);
  for (const a of recent) if (keep(a)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-limit);
}
