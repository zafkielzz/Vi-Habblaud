// Office model: agents (real and demo), rooms, feed, and notices.
// Source watchers (sources/watcher.ts) call mutation methods; the SSE hub
// calls commit() (throttled) to obtain the new snapshot, feed, and pending notices.
import type {
  AccountInfo,
  Activity,
  AgentDetail,
  AgentInfo,
  AgentStats,
  AgentStatus,
  FeedItem,
  Notice,
  NoticeLevel,
  OfficeSnapshot,
  PermissionDecision,
  PermissionRequestInfo,
  Provider,
  PtyInfo,
  PtyStatus,
  RoomInfo,
  ShellJob,
  SourceInfo,
  TaskItem,
  UpdateStatus,
  WorkerProgress,
  JobBoard,
  HandoffPlan,
  NewsItem,
  TeamInfo,
} from '../../shared/types';
import { SHELL_WAIT_TOOL, SPECIAL, type ShellOutcome } from '../../shared/activity';
import { nameKey, type AppearanceParts } from '../../shared/appearance';
import { DemoSimulator } from '../../shared/demo/simulator';
import { describeGitHubEvent, githubEventKey, RoomEffects, type GitHubEvent } from '../../shared/github';
import { hash32 } from '../../shared/hash';
import { applyPermission } from '../permissions/registry';
import type { NameStore, StoredCharacter } from './names';
import { normalizeCwd, roomDisplayNames, SlotAllocator } from './rooms';
import { tr } from '../../shared/i18n';
import type { WorldMeta } from '../../shared/world/api';

/** Boss outfit (AgentInfo.boss) for agents without a chosen character. */
const BOSS_PARTS: AppearanceParts = { topStyle: 'shirt_tie', top: '#1f2a44', topAccent: '#c0392b', bottomStyle: 'pants', bottom: '#1f2a44', shoes: '#141414' };

export const OFFLINE_GRACE_MS = 20_000;
export const DONE_GRACE_MS = 25_000;
export const SLOT_COOLDOWN_MS = 30_000;
export const NOTICE_DEDUPE_MS = 10_000;
/** "Waiting on shell" notice: at most one every 10 min per agent. */
export const SHELL_NOTICE_DEDUPE_MS = 600_000;
/** GitHub event older than this (re-read old line) does not animate room or trigger notices. */
export const GITHUB_LIVE_MS = 120_000;
const RECENT_LIMIT = 30;
/**
 * Activities per agent included in snapshot (SSE). The whole snapshot is sent on every change, and the
 * complete `recent` was ~87% of it; long timeline comes from GET /api/agents/:id and feed already
 * broadcasts each activity separately.
 */
export const SNAPSHOT_RECENT = 8;
const HISTORY_LIMIT = 200;
const FEED_LIMIT = 200;

export interface OfficeDeps {
  names: NameStore;
  /** User-chosen name for the room folder (model/room-aliases.ts), if any. */
  roomAlias?: (path: string) => string | undefined;
  version: string;
  /** Build of served client (see OfficeSnapshot.meta.build); absent in dev mode and tests. */
  build?: () => string | undefined;
  startedAt: number;
  /** Real accounts, with number of open sessions for each. */
  accounts: (sessions: ReadonlyMap<string, number>) => AccountInfo[];
  sources: () => SourceInfo[];
  /** Friendly account name (e.g. "Account D") for notices. */
  accountName: (id: string) => string | undefined;
  /** Terminal enabled (see OfficeSnapshot.meta.terminal and ServerConfig.terminal). */
  terminal?: boolean;
  /** Pending permission requests per agent (PermissionRegistry.snapshot), added to snapshot. */
  permissions?: () => ReadonlyMap<string, PermissionRequestInfo>;
  /**
   * Agents whose session is seen connected by message registry (MessageRegistry.reachable): become AgentInfo.canMessage.
   * Absent = messages from office disabled (OfficeSnapshot.meta.messages).
   */
  messages?: () => ReadonlySet<string>;
  /** New version check on GitHub (see OfficeSnapshot.meta.updates). */
  updates?: () => UpdateStatus;
  /** Interactive terminals (PtyManager): feature status and open terminals. */
  ptys?: () => { status: PtyStatus; list: PtyInfo[] };
  /** Habblaud World (WorldService.meta; see OfficeSnapshot.meta.world). */
  world?: () => WorldMeta;
  now?: () => number;
}

/** What the transcript knows about the agent (applied in one pass). */
export interface TranscriptSummary {
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  model?: string;
  /** Reasoning effort in use (low, medium, high, xhigh, max). */
  effort?: string;
  gitBranch?: string;
  permissionMode?: string;
  /** First known event (subagents: actual start, after reading beginning of file). */
  firstAt?: number;
  lastAt?: number;
}

export interface MainInput {
  id: string;
  /** Agent tool (AgentInfo.provider); absent = 'claude'. Subagents inherit the main agent's. */
  provider?: Provider;
  account: string;
  sessionId: string;
  cwd: string;
  role: string;
  startedAt: number;
  status: AgentStatus;
  waitingFor?: string;
  /** Fixed character name (e.g. Antigravity workers, "acc2-impl"); absent = randomly assigned name of the session. */
  name?: string;
}

export interface SubInput {
  id: string;
  parentId: string;
  sessionId: string;
  role: string;
  title?: string;
  background: boolean;
  startedAt: number;
}

interface AgentRecord {
  info: AgentInfo;
  history: Activity[];
  removeAt?: number;
  /** Start of current turn (for "Finished in X"). */
  turnStart?: number;
  /** Synthesized "Finished" activity from status change (replaced by transcript if provided). */
  synthDone?: { id: string; at: number };
  /** Synthesized "Needs you" activity; upon leaving wait, previous activity becomes current again. */
  synthWait?: { id: string; prev?: Activity };
  /** Synthesized "Waiting on shell" bubble in this 'shell' status episode (and the activity it covered). */
  shellWait?: { id: string; prev?: Activity };
}

/** What completed (for 'ShellDone' activity and notice). */
export interface ShellDoneInput {
  /** Job id (background task or tool_use): makes activity idempotent on re-read. */
  id: string;
  label: string;
  startedAt: number;
  command?: string;
}

/** Character chosen in editor (already validated: see shared/appearance.ts). */
export interface CharacterInput {
  name: string;
  seed: number;
  parts: AppearanceParts;
}

export type CharacterResult = { result: 'ok' } | { result: 'not-found' } | { result: 'conflict'; message: string };

export interface CommitResult {
  snapshot: OfficeSnapshot;
  changed: boolean;
  feed: FeedItem[];
  notices: Notice[];
}

type NoticeKind = 'arrive' | 'room' | 'wait' | 'deliver' | 'done' | 'leave' | 'shell' | 'shellDone' | 'github' | 'character' | 'fun';

/** Question still unanswered (its bubble already indicates the agent is waiting for you). */
function isOpenQuestion(a: Activity | undefined): boolean {
  return a?.kind === 'ask' && a.text !== SPECIAL.answered().text;
}

function zeroStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

function cloneAgent(a: AgentInfo): AgentInfo {
  const c: AgentInfo = { ...a, recent: a.recent.slice(), tasks: a.tasks.map((t) => ({ ...t })), stats: { ...a.stats } };
  if (a.shells) c.shells = a.shells.map((j) => ({ ...j }));
  if (a.parts) c.parts = { ...a.parts };
  return c;
}

/**
 * Names in use, compared case- and Unicode-insensitively: pickName and NameStore.assign only call `has`, so
 * "Ana" (stored or from pool) counts as taken when "ana" was chosen for a room.
 */
class NameSet extends Set<string> {
  private folded = new Set<string>();
  override add(name: string): this {
    // Set constructor calls add before fields exist: only use `new NameSet()` without arguments.
    this.folded?.add(nameKey(name));
    return super.add(name);
  }
  override has(name: string): boolean {
    return this.folded.has(nameKey(name));
  }
}

const byStart = (a: ShellJob, b: ShellJob) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

export class Office {
  private agents = new Map<string, AgentRecord>();
  private rooms = new Map<string, { path: string; createdAt: number }>();
  private slots = new SlotAllocator(SLOT_COOLDOWN_MS);
  private roomNames = new Map<string, string>();
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private noticeAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private rev = 0;
  private dirty = true;
  private last: OfficeSnapshot | null = null;
  private demo: DemoSimulator | null = null;
  private demoSnap: OfficeSnapshot | null = null;
  private booting = false;
  /** Sources booting right now (counted beginBoot/endBoot): boot finishes only when all complete. */
  private bootDepth = 0;
  private bootFeed: FeedItem[] = [];
  /** Room celebration/alarm (GitHub events). */
  private effects = new RoomEffects();
  private readonly boards = new Map<string, JobBoard>();
  /** "Next steps" of each room's handoff file (RoomInfo.plan; server/board.ts). */
  private readonly plans = new Map<string, HandoffPlan>();
  /** Today's news (OfficeSnapshot.news; server/board.ts). */
  private news: NewsItem[] = [];
  /** The team (OfficeSnapshot.team; server/team.ts). */
  private team: TeamInfo | undefined;
  /** The office whose building holds each room (setPlacement). */
  private roomOffices = new Map<string, string>();
  /** Room names set by the office (setRoomLabels). */
  private roomLabels = new Map<string, string>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: OfficeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Notified (synchronously) whenever something changes; hub decides when to commit(). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  markDirty(): void {
    this.dirty = true;
    this.listeners.forEach((cb) => cb());
  }

  // ---------------------------------------------------------------- boot

  /**
   * During boot: no notices; feed is assembled in chronological order at the end. Counted: each agent source
   * (sources/source.ts) calls beginBoot when starting to reconstruct open sessions and endBoot when done (in
   * `finally`, even if boot is asynchronous); office is only "ready" (sorted feed, waiting bubbles, no late
   * notices) when the last one finishes.
   */
  beginBoot(): void {
    if (this.bootDepth++ > 0) return;
    this.booting = true;
    this.bootFeed = [];
  }

  endBoot(): void {
    if (this.bootDepth === 0) return; // endBoot without beginBoot: ignored
    if (--this.bootDepth > 0) return;
    this.booting = false;
    const sorted = this.bootFeed.sort((a, b) => a.activity.at - b.activity.at).slice(-FEED_LIMIT);
    this.bootFeed = [];
    this.feed = [...this.feed, ...sorted].slice(-FEED_LIMIT);
    // Agents already waiting for you when server started get "Needs you" bubble
    // (during boot nothing is synthesized; no notice, as it's not new).
    for (const rec of this.agents.values()) {
      const info = rec.info;
      if (info.status !== 'waiting' || rec.synthWait || isOpenQuestion(info.activity)) continue;
      const prev = info.activity;
      const act: Activity = { id: `${info.id}#wait:${++this.seq}`, at: info.statusSince, ...SPECIAL.waiting(info.waitingFor) };
      this.addActivity(info.id, act, true, { feed: false });
      rec.synthWait = prev ? { id: act.id, prev } : { id: act.id };
    }
    this.markDirty();
  }

  /** Some source is still booting. */
  isBooting(): boolean {
    return this.booting;
  }

  // ---------------------------------------------------------------- queries

  has(id: string): boolean {
    return this.agents.has(id);
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id)?.info;
  }

  /** Real agents present (including grace period). */
  list(): AgentInfo[] {
    return [...this.agents.values()].map((r) => r.info);
  }

  /** Room project folder (original cwd, unnormalized). */
  roomPath(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.path;
  }

  roomName(roomId: string): string {
    return this.roomNames.get(roomId) ?? roomId.split('/').filter(Boolean).pop() ?? roomId;
  }

  detail(id: string): AgentDetail | undefined {
    const rec = this.agents.get(id);
    if (rec) return { agent: cloneAgent(rec.info), history: rec.history.slice() };
    const demo = this.demoSnap?.agents.find((a) => a.id === id);
    return demo ? { agent: cloneAgent(demo), history: demo.recent.slice() } : undefined;
  }

  recentFeed(n: number): FeedItem[] {
    return this.feed.slice(-n);
  }

  isDemo(): boolean {
    return this.demo !== null;
  }

  // ---------------------------------------------------------------- main agents

  addMain(p: MainInput): void {
    const now = this.now();
    const existing = this.agents.get(p.id);
    if (existing) {
      // Session that returned during grace period.
      delete existing.removeAt;
      this.setStatus(p.id, p.status, p.waitingFor);
      return;
    }
    const roomId = normalizeCwd(p.cwd);
    this.ensureRoom(roomId, now);
    const chosen = this.roomCharacter(roomId, p.id, p.sessionId);
    // The same session resumed in another process (e.g. "Take over here") keeps its name, even with the old process
    // still leaving the office.
    const person = chosen ?? this.deps.names.assign(p.sessionId, this.takenNames(undefined, p.sessionId));
    const info: AgentInfo = {
      id: p.id,
      kind: 'main',
      roomId,
      name: chosen ? person.name : (p.name ?? person.name),
      look: person.look,
      role: p.role,
      sessionId: p.sessionId,
      account: p.account,
      status: p.status,
      recent: [],
      tasks: [],
      startedAt: p.startedAt,
      lastEventAt: p.startedAt,
      statusSince: now,
      stats: zeroStats(),
      seed: chosen?.seed ?? hash32(p.id),
    };
    if (p.provider && p.provider !== 'claude') info.provider = p.provider;
    if (chosen) {
      info.custom = true;
      if (chosen.parts) info.parts = { ...chosen.parts };
    }
    if (p.status === 'waiting') info.waitingFor = p.waitingFor ?? tr('answer in the terminal');
    const rec: AgentRecord = { info, history: [] };
    if (p.status === 'working') rec.turnStart = now;
    this.agents.set(p.id, rec);
    const acc = this.deps.accountName(p.account);
    this.notice('arrive', p.id, 'info', tr('👋 {0} arrived in {1}{2}', [info.name, this.roomName(roomId), acc ? ` (${acc})` : '']), roomId);
    this.markDirty();
  }

  /** Same process, new session (/clear, /resume): character stays, tasks and stats reset. */
  switchSession(id: string, sessionId: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.sessionId === sessionId) return;
    const info = rec.info;
    // Project character: chosen name does not become the session's random name, and the new session becomes its owner
    // (if another agent in the room saved last, they remain the owner).
    if (info.custom) {
      const owner = this.deps.names.character(info.roomId)?.owner;
      if (owner === undefined || owner === info.sessionId) this.deps.names.claimCharacter(info.roomId, sessionId);
    } else {
      this.deps.names.remember(sessionId, { name: info.name, look: info.look });
    }
    info.sessionId = sessionId;
    info.tasks = [];
    info.stats = zeroStats();
    delete info.title;
    this.addActivity(id, { id: `${id}#clear:${++this.seq}`, at: this.now(), ...SPECIAL.cleared() }, true);
    this.markDirty();
  }

  setStatus(id: string, status: AgentStatus, waitingFor?: string): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    const prev = info.status;
    const reason = status === 'waiting' ? (waitingFor ?? tr('answer in the terminal')) : undefined;
    if (prev === status && info.waitingFor === reason) return;
    const now = this.now();
    if (prev !== status) {
      info.status = status;
      info.statusSince = now;
    }
    if (reason) info.waitingFor = reason;
    else delete info.waitingFor;
    const room = this.roomName(info.roomId);

    if (status === 'working' && (prev === 'idle' || prev === 'shell' || rec.turnStart === undefined)) rec.turnStart = now;
    if (status === 'shell' && prev !== 'shell') {
      // Turn ended with shell(s) running: bubble (fillShellActivity) and notice mention waiting, not "finished".
      const { label } = this.shellSummary(rec);
      this.notice('shell', id, 'info', tr('⏳ {0} is waiting on the shell in {1}{2}', [info.name, room, label ? `: ${label}` : '']), info.roomId, {
        dedupeMs: SHELL_NOTICE_DEDUPE_MS,
      });
    }
    if (prev === 'shell' && status !== 'shell' && rec.shellWait) {
      // Left wait with nothing new in transcript: reverts to showing what was there before synthesized bubble.
      if (info.activity?.id === rec.shellWait.id && rec.shellWait.prev) info.activity = rec.shellWait.prev;
      delete rec.shellWait;
    }
    if (status === 'waiting' && prev !== 'waiting') {
      if (!this.booting && !isOpenQuestion(info.activity)) {
        const prevActivity = info.activity;
        const act: Activity = { id: `${id}#wait:${++this.seq}`, at: now, ...SPECIAL.waiting(reason) };
        this.addActivity(id, act, true);
        rec.synthWait = prevActivity ? { id: act.id, prev: prevActivity } : { id: act.id };
      }
      this.notice('wait', id, 'alert', tr('✋ {0} needs you in {1}: {2}', [info.name, room, reason]), info.roomId);
    }
    if (prev === 'waiting' && status !== 'waiting' && rec.synthWait) {
      // Left wait with nothing new in transcript: reverts to showing previous activity.
      if (info.activity?.id === rec.synthWait.id && rec.synthWait.prev) info.activity = rec.synthWait.prev;
      delete rec.synthWait;
    }
    if (prev === 'working' && status === 'idle') {
      const cur = info.activity;
      const interrupted = cur?.kind === 'wait' && cur.text === SPECIAL.interrupted().text;
      if (!this.booting && cur?.kind !== 'done' && !interrupted) {
        const act: Activity = { id: `${id}#done:${++this.seq}`, at: now, ...SPECIAL.turnDone(rec.turnStart ? now - rec.turnStart : undefined) };
        if (rec.turnStart) act.durationMs = now - rec.turnStart;
        this.addActivity(id, act, true);
        rec.synthDone = { id: act.id, at: now };
      }
      this.notice('done', id, 'success', tr('✅ {0} finished in {1}', [info.name, room]), info.roomId);
    }
    this.markDirty();
  }

  /**
   * Busy, but transcript reported nothing new for a while (last activity is the end of the previous
   * turn — e.g. waiting on background subagents): shows something consistent with "working".
   */
  fillWorkingActivity(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.status !== 'working') return;
    const cur = rec.info.activity;
    const now = this.now();
    if (cur && (cur.kind !== 'done' || now - cur.at < 15_000)) return;
    // Stalled on foreground command (no result yet): not "thinking", waiting on command.
    if (rec.info.shells?.some((j) => !j.background)) return;
    const busySubs = [...this.agents.values()].some((r) => r.info.parentId === id && r.info.status === 'working');
    const desc = busySubs ? SPECIAL.supervising() : SPECIAL.think();
    this.addActivity(id, { id: `${id}#busy:${++this.seq}`, at: now, ...desc }, true, { filler: true });
  }

  // ---------------------------------------------------------------- shells

  /** Shells the agent is waiting on (empty list = none; field omitted from snapshot). */
  setShells(id: string, jobs: readonly ShellJob[]): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    if (info.status === 'offline' || (info.kind === 'sub' && info.status === 'done')) jobs = [];
    const next = jobs.length ? jobs.map((j) => ({ ...j })).sort(byStart) : undefined;
    if (JSON.stringify(info.shells) === JSON.stringify(next)) return;
    if (next) info.shells = next;
    else delete info.shells;
    this.markDirty();
  }

  /**
   * 'shell' status: bubble shows "Waiting on shell: <label>" — never "Finished in …" from turn end.
   * Only covers what fell behind (turn end, activities prior to wait, the wait bubble itself with another
   * label); events occurring during wait (e.g. one shell finishing) continue to appear.
   * The first bubble of each wait goes to the feed; updates do not.
   */
  fillShellActivity(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.status !== 'shell') return;
    const info = rec.info;
    const { label, count, detail } = this.shellSummary(rec);
    const desc = SPECIAL.waitingShell(label, count, detail);
    const cur = info.activity;
    const mine = cur?.tool === SHELL_WAIT_TOOL;
    if (mine && cur.text === desc.text) return;
    if (cur && !mine && cur.kind !== 'done' && cur.at > info.statusSince) return;
    const now = this.now();
    const act: Activity = { id: `${id}#shell-wait:${++this.seq}`, at: Math.max(now, info.statusSince), ...desc };
    const first = !rec.shellWait;
    const prev = mine ? rec.shellWait?.prev : cur;
    this.addActivity(id, act, true, { filler: !first || this.booting });
    rec.shellWait = prev ? { id: act.id, prev } : { id: act.id };
  }

  /**
   * A background shell finished: 'ShellDone' activity (the world celebrates; `error` = failed/killed)
   * and success/failure notice. `live: false` = past replay (history only, no notice).
   */
  shellDone(id: string, job: ShellDoneInput, outcome: ShellOutcome, at: number, opts: { live?: boolean; summary?: string } = {}): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    const live = opts.live !== false;
    const ms = Math.max(0, at - job.startedAt);
    const act: Activity = { id: `${id}#shell-done:${job.id}`, at, ...SPECIAL.shellDone(job.label, outcome, ms, opts.summary ?? job.command) };
    if (outcome === 'ok') act.durationMs = ms;
    this.addActivity(id, act, true, { feed: live });
    if (!live || outcome === 'killed') return;
    const room = this.roomName(info.roomId);
    const text =
      outcome === 'ok' ? tr('✅ {0}: shell finished in {1} — {2}', [info.name, room, job.label]) : tr('❌ {0}: shell failed in {1} — {2}', [info.name, room, job.label]);
    this.notice('shellDone', id, outcome === 'ok' ? 'success' : 'warn', text, info.roomId, { dedupeKey: `${id}|shellDone|${job.id}` });
  }

  /**
   * GitHub event seen in transcript (PR opened/merged, push, CI, release; see shared/github.ts):
   * activity in history and, when live, notice and room effect (party or alarm). `key` (tool_use)
   * makes activity idempotent on re-read; `live: false` or old line = history only.
   */
  githubEvent(id: string, ev: GitHubEvent, opts: { key: string; at: number; live?: boolean }): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    const now = this.now();
    const live = opts.live !== false && !this.booting && now - opts.at < GITHUB_LIVE_MS;
    const d = describeGitHubEvent(ev, info.name, this.roomName(info.roomId));
    this.addActivity(id, { id: `${id}#gh:${opts.key}:${ev.kind}`, at: opts.at, ...d.activity }, true, { feed: live });
    if (!live) return;
    // same CI seen again (gh run view after watch) does not repeat notice for 2 min
    const ci = ev.kind === 'ci_failed' || ev.kind === 'ci_passed';
    this.notice('github', id, d.level, d.notice, info.roomId, { dedupeKey: `${info.roomId}|gh|${githubEventKey(ev)}`, dedupeMs: ci ? 120_000 : NOTICE_DEDUPE_MS });
    if (this.effects.apply(info.roomId, ev, now, id)) this.markDirty();
  }

  /**
   * Party in agent's room (`banner`) and, with `notice`, a notice: Antigravity worker achievements and easter eggs.
   * Nothing during boot (re-read log state does not celebrate again).
   */
  celebrate(id: string, banner: string, notice?: string): void {
    const rec = this.agents.get(id);
    if (!rec || this.booting) return;
    if (this.effects.party(rec.info.roomId, banner, this.now(), id)) this.markDirty();
    // One key per banner: two achievements in same job yield two notices (default would group by agent).
    if (notice) this.notice('fun', id, 'success', notice, rec.info.roomId, { dedupeKey: `${id}|fun|${banner}` });
  }

  /** Party in all rooms (Konami code). */
  partyEverywhere(banner: string): void {
    const now = this.now();
    for (const roomId of new Set([...this.agents.values()].map((r) => r.info.roomId))) this.effects.party(roomId, banner, now);
    this.markDirty();
  }

  /**
   * Sets (or unsets) Antigravity worker boss. Agents without a chosen character get the boss outfit
   * (shirt and tie, navy suit); chosen characters remain unchanged.
   */
  setBoss(id: string, on: boolean): void {
    const rec = this.agents.get(id);
    if (!rec || !!rec.info.boss === on) return;
    const info = rec.info;
    if (on) {
      info.boss = true;
      if (!info.custom) info.parts = { ...BOSS_PARTS };
    } else {
      delete info.boss;
      if (!info.custom) delete info.parts;
    }
    this.markDirty();
  }

  /**
   * Context window the Habblaud mod reports for a Claude Code session (AgentInfo.contextWindow): the main agent of that
   * session id (and account, when given). Values outside 1k–100M are ignored.
   */
  setContextWindow(sessionId: string, account: string | undefined, window: number): void {
    if (!Number.isInteger(window) || window < 1_000 || window > 100_000_000) return;
    for (const rec of this.agents.values()) {
      const info = rec.info;
      if (info.kind !== 'main' || info.sessionId !== sessionId || (account && info.account !== account)) continue;
      if (info.contextWindow === window) continue;
      info.contextWindow = window;
      this.markDirty();
    }
  }

  /** Job board of a room (RoomInfo.board; Antigravity workers). undefined deletes. */
  setBoard(roomId: string, board: JobBoard | undefined): void {
    if (JSON.stringify(this.boards.get(roomId)) === JSON.stringify(board)) return;
    if (board) this.boards.set(roomId, board);
    else this.boards.delete(roomId);
    this.markDirty();
  }

  /** "Next steps" of a room's handoff file (RoomInfo.plan). undefined deletes. */
  setPlan(roomId: string, plan: HandoffPlan | undefined): void {
    if (JSON.stringify(this.plans.get(roomId)) === JSON.stringify(plan)) return;
    if (plan) this.plans.set(roomId, plan);
    else this.plans.delete(roomId);
    this.markDirty();
  }

  /**
   * Which office's building holds each room and each character (RoomInfo.office / AgentInfo.office; server/team.ts).
   * Missing = the first office's building.
   */
  setPlacement(rooms: ReadonlyMap<string, string>, agents: ReadonlyMap<string, string>): void {
    let dirty = false;
    if (JSON.stringify([...rooms]) !== JSON.stringify([...this.roomOffices])) {
      this.roomOffices = new Map(rooms);
      dirty = true;
    }
    for (const [id, rec] of this.agents) {
      const office = agents.get(id);
      if (rec.info.office === office) continue;
      if (office) rec.info.office = office;
      else delete rec.info.office;
      dirty = true;
    }
    if (dirty) this.markDirty();
  }

  /** Display names that win over the folder name (an office's workers room is "Workers"). */
  setRoomLabels(labels: ReadonlyMap<string, string>): void {
    if (JSON.stringify([...labels]) === JSON.stringify([...this.roomLabels])) return;
    this.roomLabels = new Map(labels);
    this.recomputeRoomNames();
    this.markDirty();
  }

  /** The team (OfficeSnapshot.team; server/team.ts). */
  setTeam(team: TeamInfo): void {
    if (JSON.stringify(this.team) === JSON.stringify(team)) return;
    this.team = team;
    this.markDirty();
  }

  /** Today's news, newest first (OfficeSnapshot.news). */
  setNews(items: NewsItem[]): void {
    if (JSON.stringify(this.news) === JSON.stringify(items)) return;
    this.news = items;
    this.markDirty();
  }

  /** Real rooms (id, folder, display name), for what is read per room (handoff file, commits). */
  roomList(): Array<{ id: string; path: string; name: string }> {
    return [...this.rooms].map(([id, r]) => ({ id, path: r.path, name: this.roomName(id) }));
  }

  /** Level and achievements of an Antigravity worker (AgentInfo.progress). */
  setProgress(id: string, progress: WorkerProgress): void {
    const rec = this.agents.get(id);
    if (!rec || JSON.stringify(rec.info.progress) === JSON.stringify(progress)) return;
    rec.info.progress = progress;
    this.markDirty();
  }

  /** Antigravity worker defaults for jobs that do not say (AgentInfo.agyDefaults). */
  setAgyDefaults(id: string, d: { mode?: string; effort?: string }): void {
    const rec = this.agents.get(id);
    if (!rec || JSON.stringify(rec.info.agyDefaults ?? {}) === JSON.stringify(d)) return;
    rec.info.agyDefaults = d;
    this.markDirty();
  }

  /** Label of oldest shell (Bash before Monitor), count, and detail (command). */
  private shellSummary(rec: AgentRecord): { label?: string; count: number; detail?: string } {
    let jobs = rec.info.shells ?? [];
    if (!jobs.length) {
      // No known own shells: some subagent might have spawned the command.
      jobs = this.descendants(rec.info.id)
        .flatMap((r) => r.info.shells ?? [])
        .filter((j) => j.background)
        .sort(byStart);
    }
    const shells = jobs.filter((j) => j.kind === 'shell' && j.background);
    const main = shells[0] ?? jobs.find((j) => j.kind === 'shell') ?? jobs[0];
    if (!main) return { count: 0 };
    // "Waiting on 2 shells": counts background Bash (monitors only if none).
    const out: { label?: string; count: number; detail?: string } = { label: main.label, count: shells.length || jobs.length };
    if (main.command) out.detail = main.command;
    return out;
  }

  closeMain(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.status === 'offline') return;
    const now = this.now();
    const info = rec.info;
    info.status = 'offline';
    info.statusSince = now;
    delete info.waitingFor;
    // Shells die with session.
    delete info.shells;
    delete rec.shellWait;
    rec.removeAt = now + OFFLINE_GRACE_MS;
    // Subagents still present leave together.
    for (const sub of this.descendants(id)) {
      delete sub.info.shells;
      if (sub.info.status !== 'done') {
        sub.info.status = 'done';
        sub.info.statusSince = now;
      }
      sub.removeAt = Math.min(sub.removeAt ?? Infinity, rec.removeAt);
    }
    this.notice('leave', id, 'info', tr('🚪 {0} ended the session', [info.name]), info.roomId);
    this.markDirty();
  }

  // ---------------------------------------------------------------- subagents

  addSub(p: SubInput): boolean {
    const parent = this.agents.get(p.parentId);
    if (!parent) return false;
    const now = this.now();
    const existing = this.agents.get(p.id);
    if (existing) {
      this.reactivateSub(p.id);
      return true;
    }
    const person = this.deps.names.assign(p.id, this.takenNames());
    const info: AgentInfo = {
      id: p.id,
      kind: 'sub',
      parentId: p.parentId,
      roomId: parent.info.roomId,
      name: person.name,
      look: person.look,
      role: p.role,
      sessionId: p.sessionId,
      account: parent.info.account,
      status: 'working',
      recent: [],
      tasks: [],
      startedAt: p.startedAt,
      lastEventAt: p.startedAt,
      statusSince: now,
      stats: zeroStats(),
      seed: hash32(p.id),
    };
    if (parent.info.provider) info.provider = parent.info.provider;
    if (p.title) info.title = p.title;
    if (p.background) info.background = true;
    this.agents.set(p.id, { info, history: [], turnStart: now });
    this.markDirty();
    return true;
  }

  completeSub(id: string, opts: { notify?: boolean } = {}): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.kind !== 'sub' || rec.info.status === 'done' || rec.info.status === 'offline') return;
    const now = this.now();
    const info = rec.info;
    info.status = 'done';
    info.statusSince = now;
    delete info.shells;
    rec.removeAt = now + DONE_GRACE_MS;
    if (!this.booting && info.activity?.kind !== 'done') {
      const act: Activity = { id: `${id}#done:${++this.seq}`, at: now, ...SPECIAL.turnDone(now - info.startedAt), durationMs: now - info.startedAt };
      this.addActivity(id, act, true);
    }
    if (opts.notify !== false) {
      const parent = info.parentId ? this.agents.get(info.parentId)?.info : undefined;
      const what = info.title ? `“${info.title}”` : tr('the work');
      this.notice('deliver', id, 'success', tr('📦 {0} delivered {1} to {2}', [info.name, what, parent?.name ?? tr('the main agent')]), info.roomId);
    }
    this.markDirty();
  }

  /** Completed subagent resumed writing (e.g. received new message): back to work. */
  reactivateSub(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.kind !== 'sub' || rec.info.status !== 'done') return;
    const parent = rec.info.parentId ? this.agents.get(rec.info.parentId) : undefined;
    if (!parent || parent.info.status === 'offline') return;
    rec.info.status = 'working';
    rec.info.statusSince = this.now();
    delete rec.removeAt;
    this.markDirty();
  }

  isSubDone(id: string): boolean {
    const s = this.agents.get(id)?.info.status;
    return s === 'done' || s === 'offline';
  }

  // ---------------------------------------------------------------- transcript data

  applyTranscript(id: string, t: TranscriptSummary): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    let changed = false;
    const set = <K extends keyof AgentInfo>(k: K, v: AgentInfo[K] | undefined) => {
      if (JSON.stringify(info[k]) === JSON.stringify(v)) return;
      if (v === undefined) delete info[k];
      else info[k] = v;
      changed = true;
    };
    if (info.kind === 'main') set('title', t.title);
    set('tasks', t.tasks.map((x) => ({ ...x })));
    set('stats', { ...t.stats });
    set('model', t.model);
    set('effort', t.effort);
    set('gitBranch', t.gitBranch);
    set('permissionMode', t.permissionMode);
    if (info.kind === 'sub' && t.firstAt !== undefined && t.firstAt < info.startedAt) {
      info.startedAt = t.firstAt;
      changed = true;
    }
    if (t.lastAt !== undefined && t.lastAt > info.lastEventAt) {
      info.lastEventAt = t.lastAt;
      changed = true;
    }
    if (changed) this.markDirty();
  }

  /**
   * Records an activity. `feed: false` = history only (e.g. re-reading end of an old transcript
   * when opening a resumed session — not new for live feed).
   */
  addActivity(id: string, activity: Activity, current: boolean, opts: { feed?: boolean; filler?: boolean } = {}): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    // "Finished" from transcript replaces what we synthesized from status change.
    if (activity.kind === 'done' && rec.synthDone && activity.at - rec.synthDone.at < 60_000) {
      const synthId = rec.synthDone.id;
      const replaced: Activity = { ...activity, id: synthId };
      const swap = (list: Activity[]) => list.map((a) => (a.id === synthId ? replaced : a));
      info.recent = swap(info.recent);
      rec.history = swap(rec.history);
      if (info.activity?.id === synthId) info.activity = replaced;
      delete rec.synthDone;
      this.markDirty();
      return;
    }
    // Re-read of a rewritten transcript: does not duplicate what is already in history.
    if (info.recent.some((a) => a.id === activity.id)) return;
    if (activity.kind !== 'done') delete rec.synthDone;
    info.recent = [...info.recent, activity].slice(-RECENT_LIMIT);
    rec.history.push(activity);
    if (rec.history.length > HISTORY_LIMIT) rec.history.splice(0, rec.history.length - HISTORY_LIMIT);
    if (current || !info.activity) info.activity = activity;
    if (activity.at > info.lastEventAt) info.lastEventAt = activity.at;
    // A new instruction starts a turn (basis of "Finished in X").
    if (activity.kind === 'prompt') rec.turnStart = activity.at;
    // `filler` (only fills character bubble) never goes to feed.
    if (!opts.filler) {
      const item: FeedItem = {
        id: activity.id,
        agentId: id,
        roomId: info.roomId,
        agentName: info.name,
        roomName: this.roomName(info.roomId),
        account: info.account,
        activity,
      };
      if (this.booting) this.bootFeed.push(item);
      else if (opts.feed !== false) this.pushFeed([item]);
    }
    this.markDirty();
  }

  /**
   * Activities prior to window read during boot (from beginning of transcript, read in background):
   * enter only long history (GET /api/agents/:id), no feed, without changing current activity.
   */
  mergeHistory(id: string, older: readonly Activity[]): void {
    const rec = this.agents.get(id);
    if (!rec || !older.length) return;
    const seen = new Set(rec.history.map((a) => a.id));
    const add = older.filter((a) => !seen.has(a.id));
    if (!add.length) return;
    rec.history = [...add, ...rec.history].sort((a, b) => a.at - b.at).slice(-HISTORY_LIMIT);
  }

  // ---------------------------------------------------------------- permission requests (server/permissions)

  /**
   * Permission request notice (or AskUserQuestion prompt) from hook; uses "needs you" deduplication
   * (same request, different path).
   */
  noticePermission(id: string, what: string, kind: 'permission' | 'question' = 'permission'): void {
    const info = this.agents.get(id)?.info;
    if (!info) return;
    const room = this.roomName(info.roomId);
    const text = kind === 'question' ? tr('❓ {0} has a question in {1}: {2}', [info.name, room, what]) : tr('🔐 {0} asks for permission in {1}: {2}', [info.name, room, what]);
    this.notice('wait', id, 'alert', text, info.roomId);
    this.markDirty();
  }

  /** Decision for a mock demo request. true = request was from demo (and answered). */
  decideDemoPermission(requestId: string, d: PermissionDecision): boolean {
    if (!this.demo) return false;
    const now = this.now();
    if (!this.demo.decidePermission(requestId, d, now)) return false;
    this.demoSnap = this.demo.snapshot(now);
    this.markDirty();
    return true;
  }

  /** Mock demo request (already complete in snapshot). */
  demoPermission(requestId: string): PermissionRequestInfo | undefined {
    return this.demoSnap?.agents.find((a) => a.permission?.id === requestId)?.permission;
  }

  // ---------------------------------------------------------------- messages from office (server/messages)

  /** Mock demo agent (only exists in snapshot), for message registry. */
  demoAgent(id: string): AgentInfo | undefined {
    return this.demoSnap?.agents.find((a) => a.id === id);
  }

  /** Mock message delivery to demo agent. false = already left (or demo turned off). */
  deliverDemoMessage(agentId: string, text: string): boolean {
    if (!this.demo) return false;
    const now = this.now();
    if (!this.demo.receiveMessage(agentId, text, now)) return false;
    this.demoSnap = this.demo.snapshot(now);
    this.markDirty();
    return true;
  }

  // ---------------------------------------------------------------- demo

  setDemo(enabled: boolean): void {
    if (enabled === this.isDemo()) return;
    const now = this.now();
    if (enabled) {
      this.demo = new DemoSimulator({ idPrefix: 'demo:' }, now);
      this.demoSnap = this.demo.snapshot(now);
    } else {
      this.demo = null;
      this.demoSnap = null;
    }
    this.recomputeRoomNames();
    this.markDirty();
  }

  // ---------------------------------------------------------------- project character (editor)

  /** Chooses name and appearance for main agent `id` and saves as the room character. */
  setCharacter(id: string, input: CharacterInput): CharacterResult {
    const rec = this.editable(id);
    if (!rec) return { result: 'not-found' };
    const info = rec.info;
    // Departing agents count here: when reopened within grace period, returns with their name.
    const conflict = this.nameConflict(input.name, id, info.roomId, true);
    if (conflict) return { result: 'conflict', message: conflict };
    const before = info.name;
    const parts = Object.keys(input.parts).length ? { ...input.parts } : undefined;
    // Another main agent in the room holding the character keeps their current name, now saved as their session's
    // name: after restart, each session returns as who it was, not the character this one saved.
    for (const r of this.agents.values()) {
      const o = r.info;
      if (o.id === id || o.kind !== 'main' || o.roomId !== info.roomId || !o.custom) continue;
      this.deps.names.remember(o.sessionId, { name: o.name, look: o.look });
      delete o.custom;
    }
    this.deps.names.setCharacter(info.roomId, { name: input.name, look: info.look, seed: input.seed, ...(parts ? { parts } : {}), owner: info.sessionId });
    info.name = input.name;
    info.seed = input.seed;
    if (parts) info.parts = parts;
    else delete info.parts;
    info.custom = true;
    const room = this.roomName(info.roomId);
    const text = before === input.name ? tr('✏️ {0} got a new look in {1}', [input.name, room]) : tr('✏️ {0} is now {1} in {2}', [before, input.name, room]);
    this.notice('character', id, 'info', text, info.roomId, { dedupeMs: 0 });
    this.markDirty();
    return { result: 'ok' };
  }

  /**
   * "Reset to draw": agent reverts to session name and id seed; room loses character only if owned by this
   * session (what another room session saved later remains theirs).
   */
  resetCharacter(id: string): 'ok' | 'not-found' {
    const rec = this.editable(id);
    if (!rec) return 'not-found';
    const info = rec.info;
    const owner = this.deps.names.character(info.roomId)?.owner;
    if (owner === undefined || owner === info.sessionId) this.deps.names.clearCharacter(info.roomId);
    if (info.custom) {
      const person = this.deps.names.assign(info.sessionId, this.takenNames(id));
      info.name = person.name;
      info.look = person.look;
      info.seed = hash32(id);
      delete info.parts;
      delete info.custom;
    }
    this.markDirty();
    return 'ok';
  }

  /** Real, present main agent (not subagent, demo, or leaving). */
  private editable(id: string): AgentRecord | undefined {
    const rec = this.agents.get(id);
    return rec && rec.info.kind === 'main' && rec.removeAt === undefined ? rec : undefined;
  }

  /**
   * Character chosen for the room, if its name is available; recipient becomes owner. Departing agents do not
   * count: usually the same session reopened (new pid) within grace period. A non-owner session that already has
   * a saved name keeps its own: after restart, arrival order does not swap identities or change character midway.
   */
  private roomCharacter(roomId: string, id: string, sessionId: string): StoredCharacter | undefined {
    const c = this.deps.names.character(roomId);
    if (!c) return undefined;
    if (c.owner !== undefined && c.owner !== sessionId && this.deps.names.get(sessionId)) return undefined;
    if (this.nameConflict(c.name, id, roomId)) return undefined;
    this.deps.names.claimCharacter(roomId, sessionId);
    return c;
  }

  /**
   * Why `name` cannot be the character of `id` in room `roomId` (undefined = allowed). Leaving agents only count with
   * `leaving`: on arrival it is usually the same reopened session; in the editor, someone who might return with that name.
   */
  private nameConflict(name: string, id: string, roomId: string, leaving = false): string | undefined {
    const key = nameKey(name);
    for (const r of this.agents.values()) {
      if (r.info.id === id || (r.removeAt !== undefined && !leaving) || nameKey(r.info.name) !== key) continue;
      return tr('{0} is already in the office, in {1}', [r.info.name, this.roomName(r.info.roomId)]);
    }
    for (const a of this.demoSnap?.agents ?? []) {
      if (nameKey(a.name) === key) return tr('{0} is already in the office, in {1}', [a.name, this.roomName(a.roomId)]);
    }
    for (const [n, room] of this.deps.names.reservedNames(roomId)) {
      if (nameKey(n) === key) return tr("{0} is already {1}'s character", [n, this.roomName(room)]);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- clock

  /** Advances demo and removes agents whose grace period expired. Call every ~250 ms. */
  tick(): void {
    const now = this.now();
    if (this.demo) {
      const r = this.demo.tick(now);
      if (r.changed) {
        this.demoSnap = this.demo.snapshot(now);
        this.recomputeRoomNames();
        this.dirty = true;
      }
      if (r.feed.length) this.pushFeed(r.feed);
      this.pendingNotices.push(...r.notices);
      if (r.changed || r.feed.length || r.notices.length) this.markDirty();
    }
    let removed = false;
    for (const [id, rec] of this.agents) {
      if (rec.removeAt !== undefined && now >= rec.removeAt) {
        this.agents.delete(id);
        removed = true;
      }
    }
    // party ended / alarm expired: snapshot omits effect
    if (this.effects.prune(now)) this.markDirty();
    if (removed) {
      const occupied = new Set([...this.agents.values()].map((r) => r.info.roomId));
      for (const id of [...this.rooms.keys()]) if (!occupied.has(id)) this.rooms.delete(id);
      this.recomputeRoomNames();
      this.markDirty();
    }
  }

  /** Closes a revision: returns snapshot (new if changed), feed, and pending notices. */
  commit(): CommitResult {
    const feed = this.pendingFeed;
    const notices = this.pendingNotices;
    this.pendingFeed = [];
    this.pendingNotices = [];
    if (!this.dirty && this.last) return { snapshot: this.last, changed: false, feed, notices };
    this.rev++;
    this.dirty = false;
    this.last = this.build();
    return { snapshot: this.last, changed: true, feed, notices };
  }

  // ---------------------------------------------------------------- internals

  private build(): OfficeSnapshot {
    const now = this.now();
    const entries = new Map(this.rooms);
    for (const r of this.demoSnap?.rooms ?? []) entries.set(r.id, { path: r.path, createdAt: r.createdAt });
    this.slots.sync(entries.keys(), now);
    const rooms: RoomInfo[] = [...entries]
      .map(([id, r]) => ({
        id,
        name: this.roomName(id),
        path: r.path,
        slot: this.slots.slotOf(id) ?? 0,
        seed: hash32(id),
        createdAt: r.createdAt,
        ...(this.roomOffices.get(id) ? { office: this.roomOffices.get(id) } : {}),
      }))
      .sort((a, b) => a.slot - b.slot);
    // party/alarm (GitHub events): from real rooms or demo
    for (const room of rooms) {
      const effect = this.effects.get(room.id, now) ?? this.demoSnap?.rooms.find((r) => r.id === room.id)?.effect;
      if (effect) room.effect = { ...effect };
      const board = this.boards.get(room.id);
      if (board) room.board = board;
      const plan = this.plans.get(room.id);
      if (plan) room.plan = plan;
    }
    const perms = this.deps.permissions?.();
    const real = [...this.agents.values()].map((r) => applyPermission(cloneAgent(r.info), perms?.get(r.info.id)));
    const reach = this.deps.messages?.();
    // Messages from office: present main agents whose session has plugin connected. In demo simulator decides;
    // when feature is disabled, nobody receives.
    for (const a of real) if (reach?.has(a.id) && a.kind === 'main' && a.status !== 'offline' && a.status !== 'done') a.canMessage = true;
    const demoAgents = (this.demoSnap?.agents ?? []).map((a) => {
      if (reach || !a.canMessage) return a;
      const { canMessage: _off, ...rest } = a;
      return rest;
    });
    const trim = (a: AgentInfo): AgentInfo => (a.recent.length > SNAPSHOT_RECENT ? { ...a, recent: a.recent.slice(-SNAPSHOT_RECENT) } : a);
    const sessions = new Map<string, number>();
    for (const a of real) if (a.kind === 'main' && a.status !== 'offline') sessions.set(a.account, (sessions.get(a.account) ?? 0) + 1);
    const ptys = this.deps.ptys?.();
    return {
      rev: this.rev,
      serverTime: now,
      rooms,
      agents: [...real, ...demoAgents].map(trim),
      accounts: [...this.deps.accounts(sessions), ...(this.demoSnap?.accounts ?? [])],
      ...(ptys ? { ptys: ptys.list } : {}),
      ...(this.news.length ? { news: this.news } : {}),
      ...(this.team ? { team: this.team } : {}),
      meta: {
        demo: this.isDemo(),
        sources: this.deps.sources(),
        startedAt: this.deps.startedAt,
        version: this.deps.version,
        build: this.deps.build?.(),
        terminal: this.deps.terminal === true,
        messages: this.deps.messages !== undefined,
        ...(ptys ? { pty: ptys.status } : {}),
        updates: this.deps.updates?.(),
        ...(this.deps.world ? { world: this.deps.world() } : {}),
      },
    };
  }

  /**
   * Names that cannot be randomly assigned: those in the office (except `exceptId` and main agents of session
   * `exceptSession`) and those chosen for rooms.
   */
  private takenNames(exceptId?: string, exceptSession?: string): Set<string> {
    const used = new NameSet();
    for (const r of this.agents.values()) {
      if (r.info.id === exceptId || (exceptSession && r.info.kind === 'main' && r.info.sessionId === exceptSession)) continue;
      used.add(r.info.name);
    }
    for (const a of this.demoSnap?.agents ?? []) used.add(a.name);
    for (const n of this.deps.names.reservedNames().keys()) used.add(n);
    return used;
  }

  private descendants(id: string): AgentRecord[] {
    const out: AgentRecord[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const rec of this.agents.values()) {
        if (rec.info.parentId === cur) {
          out.push(rec);
          queue.push(rec.info.id);
        }
      }
    }
    return out;
  }

  private ensureRoom(roomId: string, now: number): void {
    if (this.rooms.has(roomId)) return;
    this.rooms.set(roomId, { path: roomId, createdAt: now });
    this.recomputeRoomNames();
    this.notice('room', roomId, 'info', tr('🏗️ New room: {0}', [this.roomName(roomId)]), roomId);
  }

  private recomputeRoomNames(): void {
    const paths = new Map([...this.rooms].map(([id, r]) => [id, r.path]));
    for (const r of this.demoSnap?.rooms ?? []) paths.set(r.id, r.path);
    this.roomNames = roomDisplayNames(paths);
    for (const [id, path] of paths) {
      const alias = this.deps.roomAlias?.(path) ?? this.roomLabels.get(id);
      if (alias) this.roomNames.set(id, alias);
    }
  }

  /** Room name changed (rename): recalculates and broadcasts. */
  refreshRoomNames(): void {
    this.recomputeRoomNames();
    this.markDirty();
  }

  private pushFeed(items: FeedItem[]): void {
    this.pendingFeed.push(...items);
    this.feed.push(...items);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }

  private notice(
    kind: NoticeKind,
    key: string,
    level: NoticeLevel,
    text: string,
    roomId?: string,
    opts: { dedupeKey?: string; dedupeMs?: number } = {},
  ): void {
    if (this.booting) return;
    const now = this.now();
    const k = opts.dedupeKey ?? `${key}|${kind}`;
    const window = opts.dedupeMs ?? NOTICE_DEDUPE_MS;
    const last = this.noticeAt.get(k);
    if (last !== undefined && now - last < window) return;
    this.noticeAt.set(k, now);
    if (this.noticeAt.size > 2_000) {
      // Only forget what passed the longest window (shell notice).
      for (const [nk, t] of this.noticeAt) if (now - t > Math.max(NOTICE_DEDUPE_MS, SHELL_NOTICE_DEDUPE_MS)) this.noticeAt.delete(nk);
    }
    const n: Notice = { id: `n-${now.toString(36)}-${++this.seq}`, level, text, at: now };
    if (kind !== 'room') n.agentId = key;
    if (roomId) n.roomId = roomId;
    this.pendingNotices.push(n);
  }
}
