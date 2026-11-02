// Claude Code agent source (AgentSource 'claude', see sources/source.ts).
// Watches OPEN Claude Code sessions across all accounts and feeds the Office:
// session registry (status), session transcript (activities, tasks, numbers) and
// subagents (files in <session>/subagents/, including workflows).
//
// Performance: the ~1s polling touches only session registries, open session
// transcripts and those sessions' subagents/ folders (never the archive of old transcripts).
// fs.watch is only an accelerator (in Docker with macOS bind mounts events may not arrive).
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { SPECIAL } from '../../shared/activity';
import type { Activity, AgentStatus, SourceInfo } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import { errMsg, log } from '../log';
import type { Office, TranscriptSummary } from '../model/office';
import { compareVersions, registryStatus, RegistryReader, SHELL_STATUS_VERSION, type RegistryEntry } from './registry';
import { SHELL_FALLBACK_MAX_AGE_MS, ShellTracker, toShellJob, type ShellFinish } from './shells';
import type { AgentSource } from './source';
import {
  BOOT_RECENT_MS,
  concludedByIdle,
  PENDING_TOOL_TIMEOUT_MS,
  listSubagentFiles,
  parseJournal,
  readSubagentMeta,
  sessionDirOf,
  subagentRole,
  type JournalAgent,
  type SubagentFile,
  type SubagentMeta,
} from './subagents';
import { FileTail } from './tail';
import {
  createTranscriptState,
  mergePrefix,
  parseLine,
  scanPrefix,
  titleOf,
  type LineResult,
  type ParseContext,
  type ShellEvent,
  type SpawnInfo,
  type TranscriptSignal,
  type TranscriptState,
} from './transcript';
import { tr } from '../../shared/i18n';

export interface WatcherOptions {
  accounts: AccountsService;
  office: Office;
  inDocker: boolean;
  now?: () => number;
  pollMs?: number;
  /** How much of the end of each transcript is read when opening the session (default 1 MB). */
  tailBytes?: number;
  isAlive?: (pid: number) => boolean;
  /** Disables fs.watch (tests). */
  watch?: boolean;
  /** Sessions left to another part of the office (Claude workers' terminals, server/workers): not shown as sessions. */
  ignore?: (accountId: string, pid: number) => boolean;
}

/** cwd -> folder name in projects/ (every non-alphanumeric character becomes "-"). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** No status in registry (older versions): inferred from transcript. */
function statusFromTranscript(state: TranscriptState, now: number): AgentStatus {
  if (state.ended) return 'idle';
  return state.lastAt !== undefined && now - state.lastAt < 90_000 ? 'working' : 'idle';
}

/** Applies a signal to the shell tracker; returns the completion of a job, if any. */
function applyShellSignal(shells: ShellTracker, owner: string, sig: TranscriptSignal, at: number): ShellFinish | undefined {
  switch (sig.type) {
    case 'shellStart':
      shells.start(owner, sig.shell);
      return undefined;
    case 'shellResult':
      shells.result(sig.toolUseId, { taskId: sig.taskId, error: sig.error, at });
      return undefined;
    case 'turnEnd':
      shells.endForeground(owner, at);
      return undefined;
    case 'notification':
      return shells.notify({ toolUseId: sig.toolUseId, taskId: sig.taskId, status: sig.status, summary: sig.summary, at });
    case 'stopped':
      return shells.stop(sig.taskId, at);
    default:
      return undefined;
  }
}

interface SubTracker {
  agentId: string;
  id: string;
  file: SubagentFile;
  meta?: SubagentMeta;
  tail: FileTail;
  state: TranscriptState;
}

interface SessionTracker {
  key: string;
  accountId: string;
  dir: string;
  entry: RegistryEntry;
  sessionId: string;
  transcriptPath?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: TranscriptState;
  customTitleFile?: string;
  subs: Map<string, SubTracker>;
  /** Subagent files already seen and outside the office: known size. */
  known: Map<string, number>;
  spawns: Map<string, SpawnInfo & { owner: string }>;
  launched: Map<string, { agentId?: string; runId?: string }>;
  taskToTool: Map<string, string>;
  runToTool: Map<string, string>;
  finishedTools: Set<string>;
  finishedAgents: Set<string>;
  finishedRuns: Set<string>;
  journals: Map<string, { size: number; agents: Map<string, JournalAgent> }>;
  /** Shells (Bash/Monitor) that the main agent and subagents of this session are awaiting. */
  shells: ShellTracker;
  workflowAgents: number;
  lastSubScanAt: number;
  /** The subagents folder has already been scanned at least once. */
  scanned: boolean;
  watchers: FSWatcher[];
  /** fs.watch of the subagents/ folder already installed (it may appear after the transcript). */
  watchingSubs: boolean;
  /** When the session stopped appearing in the registry. */
  missingSince?: number;
  /** Since when the registry (from a version that writes "shell") says "idle". */
  idleSince?: number;
}

const MAX_SET = 2_000;
/** Text of the "Received background result" activity (delivery of a <task-notification>). */
const BACKGROUND_RESULT_TEXT = SPECIAL.backgroundResult().text;
/** Activities recovered from the start of the main transcript for the long timeline. */
const PREFIX_HISTORY = 120;
/** Time a session needs to stay out of the registry before being marked as closed. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/**
 * Registry "idle" (from a version that writes "shell") for this duration = no background shell running;
 * the margin covers the completion notification still on its way to the transcript.
 */
const IDLE_CLEARS_SHELLS_MS = 30_000;

function addBounded(set: Set<string>, v: string): void {
  set.add(v);
  if (set.size > MAX_SET) set.delete(set.values().next().value as string);
}

/** A failing line does not discard the remaining lines already consumed by tail. */
function parseWatchedLine(state: TranscriptState, line: string, ctx: ParseContext): LineResult {
  try {
    return parseLine(state, line, ctx);
  } catch (err) {
    log.warnOnce(`line:${ctx.idPrefix}:${errMsg(err)}`, tr('Transcript line from {0} skipped: {1}', [ctx.idPrefix, errMsg(err)]));
    return { activities: [], signals: [], changed: false, at: ctx.now };
  }
}

export class ClaudeWatcher implements AgentSource {
  readonly provider = 'claude' as const;
  private readers = new Map<string, RegistryReader>();
  private sessions = new Map<string, SessionTracker>();
  private sourceInfo = new Map<string, SourceInfo>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private stopped = false;
  /** Lowest Claude Code version seen writing "shell" to registry (starts at known version). */
  private shellStatusVersion = SHELL_STATUS_VERSION;

  constructor(private readonly opts: WatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
  }

  /** Boot + periodic polling. */
  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Rebuilds open sessions without emitting notices (the feed outputs in chronological order). Synchronous. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.sessions.values()) this.closeWatchers(t);
  }

  sources(): SourceInfo[] {
    return this.opts.accounts.entries().map(
      (e) => this.sourceInfo.get(e.dir) ?? { label: e.id, path: e.detected.configDir, sessions: 0, ok: true },
    );
  }

  /**
   * Transcript path of an active agent (terminal): main = "<account>:<pid>"
   * (after /clear or /resume, the new transcript); subagent = "<sessionId>:<agentId>". Undefined if
   * agent is not tracked (or the main transcript has not yet been found).
   */
  transcriptPathOf(agentId: string): string | undefined {
    const main = this.sessions.get(agentId);
    if (main) return main.transcriptPath;
    for (const t of this.sessions.values()) {
      if (!agentId.startsWith(`${t.sessionId}:`)) continue;
      for (const sub of t.subs.values()) if (sub.id === agentId) return sub.file.path;
    }
    return undefined;
  }

  /** Awaits pending prefix reads (tests). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`poll:${errMsg(err)}`, tr('Read cycle failed: {0}', [errMsg(err)]));
    }
  }

  /** Accelerator: an fs.watch event triggers the next cycle sooner. */
  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    this.lastPollAt = this.now();
    const seen = new Set<string>();
    for (const acc of this.opts.accounts.entries()) {
      let reader = this.readers.get(acc.dir);
      if (!reader) {
        reader = new RegistryReader(acc.dir, { checkPid: !this.opts.inDocker, isAlive: this.opts.isAlive });
        this.readers.set(acc.dir, reader);
        this.watchDir(join(acc.dir, 'sessions'));
      }
      const res = reader.poll();
      const info: SourceInfo = { label: acc.id, path: acc.detected.configDir, sessions: res.entries.length, ok: res.ok };
      if (res.error) info.error = res.error;
      this.sourceInfo.set(acc.dir, info);
      for (const entry of res.entries) {
        if (this.opts.ignore?.(acc.id, entry.pid)) continue;
        const key = `${acc.id}:${entry.pid}`;
        seen.add(key);
        try {
          this.syncSession(key, acc.id, acc.dir, entry, boot);
        } catch (err) {
          log.warnOnce(`session:${key}:${errMsg(err)}`, tr('Session {0}: {1}', [key, errMsg(err)]));
        }
      }
    }
    const now = this.now();
    for (const [key, t] of [...this.sessions]) {
      if (seen.has(key)) {
        delete t.missingSince;
        continue;
      }
      // Disappeared from registry for an instant (file being rewritten)? Only closes if it remains gone.
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.closeWatchers(t);
      this.sessions.delete(key);
      this.opts.office.closeMain(key);
    }
  }

  private syncSession(key: string, accountId: string, dir: string, entry: RegistryEntry, boot: boolean): void {
    const office = this.opts.office;
    let t = this.sessions.get(key);
    if (!t) {
      t = this.newTracker(key, accountId, dir, entry);
      this.sessions.set(key, t);
      const st = registryStatus(entry);
      office.addMain({
        id: key,
        account: accountId,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        role: entry.agent ? tr('Agent {0}', [entry.agent]) : tr('Main agent'),
        startedAt: entry.startedAt ?? this.now(),
        status: st.status ?? 'idle',
        waitingFor: st.waitingFor,
      });
    } else if (t.sessionId !== entry.sessionId) {
      // /clear or /resume in the same process: same character, new transcript.
      for (const sub of t.subs.values()) office.completeSub(sub.id, { notify: false });
      this.closeWatchers(t);
      const fresh = this.newTracker(key, accountId, dir, entry);
      this.sessions.set(key, fresh);
      office.switchSession(key, entry.sessionId);
      t = fresh;
    }
    t.entry = entry;
    this.pumpMain(t);
    this.scanSubagents(t, boot);
    this.pumpSubs(t);
    const now = this.now();
    const st = registryStatus(entry);
    // Shells die with the process: what started before it (resumed session) is not running.
    t.shells.prune(now, entry.startedAt);
    t.shells.holdForeground(st.status === 'waiting', now);
    this.publishShells(t);
    let status = st.status ?? statusFromTranscript(t.state, now);
    const writesShell = this.writesShellStatus(entry);
    if (entry.status === 'idle' && writesShell) {
      // This version writes "shell": "idle" ensures no Bash is in background (leftovers missed their finish).
      t.idleSince ??= now;
      if (now - t.idleSince >= IDLE_CLEARS_SHELLS_MS && t.shells.dropBackgroundShells(now)) this.publishShells(t);
    } else {
      delete t.idleSince;
      // Older CLIs do not write "shell": idle with background Bash without notification = waiting for shell.
      if (status === 'idle' && t.shells.hasBackgroundShell(now, SHELL_FALLBACK_MAX_AGE_MS)) status = 'shell';
    }
    office.setStatus(key, status, st.waitingFor);
    office.fillWorkingActivity(key);
    office.fillShellActivity(key);
  }

  /** Does this session's version write "shell" to the registry? (learns from sessions that already wrote it) */
  private writesShellStatus(entry: RegistryEntry): boolean {
    if (!entry.version) return false;
    if (entry.status === 'shell' && compareVersions(entry.version, this.shellStatusVersion) < 0) this.shellStatusVersion = entry.version;
    return compareVersions(entry.version, this.shellStatusVersion) >= 0;
  }

  /**
   * Publishes the shells of each agent in the session. A background shell of a subagent that already exited
   * keeps running: it moves to the main agent (its registry counts these shells too).
   */
  private publishShells(t: SessionTracker): void {
    const office = this.opts.office;
    const byOwner = new Map<string, ReturnType<typeof toShellJob>[]>();
    for (const job of t.shells.list()) {
      let owner = job.owner;
      if (owner !== t.key && (!office.has(owner) || office.isSubDone(owner))) {
        if (!job.background) continue;
        owner = t.key;
      }
      const list = byOwner.get(owner) ?? [];
      list.push(toShellJob(job));
      byOwner.set(owner, list);
    }
    office.setShells(t.key, byOwner.get(t.key) ?? []);
    for (const sub of t.subs.values()) office.setShells(sub.id, byOwner.get(sub.id) ?? []);
  }

  /** A background shell finished: 'ShellDone' activity on owner (or on main if owner already exited). */
  private reportShellDone(t: SessionTracker, fin: ShellFinish, live: boolean): void {
    const job = fin.job;
    if (job.kind !== 'shell' || !job.background) return;
    const office = this.opts.office;
    let owner = job.owner;
    if (!office.has(owner) || (owner !== t.key && office.isSubDone(owner))) owner = t.key;
    const exit = fin.summary ? /exit code (-?\d+)/i.exec(fin.summary)?.[1] : undefined;
    const detail = [exit !== undefined ? tr('Exit code {0}', [exit]) : undefined, job.command].filter(Boolean).join(' — ') || fin.summary;
    const input: { id: string; label: string; startedAt: number; command?: string } = { id: job.taskId ?? job.toolUseId, label: job.label, startedAt: job.startedAt };
    if (job.command) input.command = job.command;
    office.shellDone(owner, input, fin.outcome, fin.at, detail ? { live, summary: detail } : { live });
  }

  private newTracker(key: string, accountId: string, dir: string, entry: RegistryEntry): SessionTracker {
    return {
      key,
      accountId,
      dir,
      entry,
      sessionId: entry.sessionId,
      nextResolveAt: 0,
      state: createTranscriptState(),
      subs: new Map(),
      known: new Map(),
      spawns: new Map(),
      launched: new Map(),
      taskToTool: new Map(),
      runToTool: new Map(),
      finishedTools: new Set(),
      finishedAgents: new Set(),
      finishedRuns: new Set(),
      journals: new Map(),
      shells: new ShellTracker(),
      workflowAgents: 0,
      lastSubScanAt: 0,
      scanned: false,
      watchers: [],
      watchingSubs: false,
    };
  }

  // ---------------------------------------------------------------- main transcript

  private resolveTranscript(t: SessionTracker): string | undefined {
    const now = this.now();
    if (now < t.nextResolveAt) return undefined;
    t.nextResolveAt = now + 3_000;
    const name = `${t.sessionId}.jsonl`;
    const projects = join(t.dir, 'projects');
    const expected = join(projects, encodeCwd(t.entry.cwd), name);
    if (existsSync(expected)) return expected;
    // Long paths may be shortened by Claude Code: look up by sessionId.
    try {
      for (const d of readdirSync(projects)) {
        const p = join(projects, d, name);
        if (existsSync(p)) return p;
      }
    } catch {
      // projects/ does not exist yet
    }
    return undefined;
  }

  private pumpMain(t: SessionTracker): void {
    if (!t.tail) {
      const path = this.resolveTranscript(t);
      if (!path) return;
      t.transcriptPath = path;
      this.loadMain(t, path);
      this.watchSession(t);
      return;
    }
    for (let i = 0; i < 4; i++) {
      const r = t.tail.read();
      if (r.reset) {
        log.warn(tr('Transcript of session {0} was truncated/replaced; rereading.', [t.key]));
        this.loadMain(t, t.tail.path);
        return;
      }
      this.applyMainLines(t, r.lines, true);
      if (r.lines.length) this.applyMainSummary(t);
      if (!r.more) break;
    }
  }

  /** Reads the end of the transcript (≈1 MB) and schedules reading the start in the background. */
  private loadMain(t: SessionTracker, path: string): void {
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.state = createTranscriptState({ trackPrefix: start > 0 });
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      this.applyMainLines(t, r.lines, false);
      if (!r.more) break;
    }
    t.customTitleFile = readCustomTitleFile(sessionDirOf(path));
    if (t.customTitleFile) t.state.customTitle ??= t.customTitleFile;
    this.applyMainSummary(t);
    const state = t.state;
    if (start > 0) {
      this.queuePrefix(
        path,
        start,
        state,
        (signals, older, shellEvents) => {
          if (this.sessions.get(t.key) !== t || t.state !== state) return;
          for (const sig of signals) this.applySignal(t, t.key, sig);
          this.mergeOlderShells(t, t.key, shellEvents);
          if (t.customTitleFile) state.customTitle ??= t.customTitleFile;
          this.applyMainSummary(t);
          // The tail window (≈1 MB) may only cover minutes of a long session: completes the timeline.
          this.opts.office.mergeHistory(t.key, older);
        },
        { idPrefix: t.key, keepActivities: PREFIX_HISTORY },
      );
    }
  }

  /**
   * Applies a batch of lines from the main agent. Claude Code only writes the AskUserQuestion call together
   * with the answer: if the question arrives in the batch already answered, it becomes "Received your answer"
   * (in the right place in the feed) instead of a delayed "Asking a question".
   */
  private applyMainLines(t: SessionTracker, lines: string[], live: boolean): void {
    const results = lines.map((line) => parseWatchedLine(t.state, line, { idPrefix: t.key, now: this.now() }));
    for (const r of results) {
      for (const a of r.activities) {
        if (a.activity.kind === 'ask' && a.toolUseId && !t.state.pendingTools.has(a.toolUseId)) {
          a.activity = { ...a.activity, ...SPECIAL.answered(a.activity.detail) };
        }
      }
      this.applyResult(t, t.key, r, live);
    }
  }

  private applyMainSummary(t: SessionTracker): void {
    const s = t.state;
    const summary: TranscriptSummary = {
      tasks: s.tasks,
      stats: { ...s.stats, subagents: s.stats.subagents + t.workflowAgents },
    };
    const title = titleOf(s);
    if (title) summary.title = title;
    if (s.model) summary.model = s.model;
    if (s.effort) summary.effort = s.effort;
    if (s.gitBranch) summary.gitBranch = s.gitBranch;
    if (s.permissionMode) summary.permissionMode = s.permissionMode;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  private queuePrefix(
    path: string,
    end: number,
    state: TranscriptState,
    done: (signals: TranscriptSignal[], older: Activity[], shellEvents: ShellEvent[]) => void,
    opts: { idPrefix?: string; keepActivities?: number } = {},
  ): void {
    const skip = new Set(state.firstMsgIds ?? []);
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, skip, opts);
        mergePrefix(state, prefix.state);
        done(prefix.signals, prefix.activities, prefix.shellEvents);
      })
      .catch((err) => log.warnOnce(`prefix:${path}`, tr("Couldn't read the start of a transcript ({0}).", [errMsg(err)])));
  }

  /**
   * Background shells that remained open at the start of the file (read after the tail window):
   * added to the tracker, unless the tail window already showed their completion.
   */
  private mergeOlderShells(t: SessionTracker, owner: string, events: readonly ShellEvent[]): void {
    if (!events.length) return;
    const older = new ShellTracker();
    for (const e of events) applyShellSignal(older, owner, e.signal, e.at);
    if (t.shells.merge(older.openBackground())) t.shells.prune(this.now(), t.entry.startedAt);
  }

  /** Applies activities and signals from a line (from main or a subagent). */
  private applyResult(t: SessionTracker, agentId: string, r: LineResult, live: boolean): void {
    const office = this.opts.office;
    // The queue already reported the end of this shell ('ShellDone'): delivering the same notification to
    // the agent goes to history only, without removing 'ShellDone' from the bubble (world cheers current activity).
    const note = r.signals.find((sig) => sig.type === 'notification');
    const reported = note?.type === 'notification' && t.shells.reportedRecently(note, r.at);
    for (const a of r.activities) {
      const current = a.current && !(reported && a.activity.text === BACKGROUND_RESULT_TEXT);
      office.addActivity(agentId, a.activity, current, { feed: live });
    }
    for (const sig of r.signals) this.applySignal(t, agentId, sig, r.at, live);
  }

  private applySignal(t: SessionTracker, owner: string, sig: TranscriptSignal, at = this.now(), live = true): void {
    const fin = applyShellSignal(t.shells, owner, sig, at);
    if (fin) this.reportShellDone(t, fin, live);
    switch (sig.type) {
      case 'spawn':
        t.spawns.set(sig.spawn.toolUseId, { ...sig.spawn, owner });
        if (t.spawns.size > MAX_SET) t.spawns.delete(t.spawns.keys().next().value as string);
        return;
      case 'launched':
        t.launched.set(sig.toolUseId, { agentId: sig.agentId, runId: sig.runId });
        if (sig.taskId) t.taskToTool.set(sig.taskId, sig.toolUseId);
        if (sig.runId) t.runToTool.set(sig.runId, sig.toolUseId);
        return;
      case 'finished':
        this.finishTool(t, sig.toolUseId);
        if (sig.agentId) addBounded(t.finishedAgents, sig.agentId);
        if (sig.runId) addBounded(t.finishedRuns, sig.runId);
        return;
      case 'notification': {
        const tool = sig.toolUseId ?? (sig.taskId ? t.taskToTool.get(sig.taskId) : undefined);
        if (tool) this.finishTool(t, tool);
        return;
      }
      case 'stopped': {
        const tool = t.taskToTool.get(sig.taskId);
        if (tool) this.finishTool(t, tool);
        return;
      }
      case 'github':
        // Only live events animate the room; initial load (boot, resumed session) goes to history.
        this.opts.office.githubEvent(owner, sig.event, { key: sig.toolUseId, at, live });
        return;
      default:
        return;
    }
  }

  private finishTool(t: SessionTracker, toolUseId: string): void {
    addBounded(t.finishedTools, toolUseId);
    const l = t.launched.get(toolUseId);
    if (l?.agentId) addBounded(t.finishedAgents, l.agentId);
    if (l?.runId) addBounded(t.finishedRuns, l.runId);
  }

  // ---------------------------------------------------------------- subagents

  private isFinished(t: SessionTracker, file: SubagentFile, meta: SubagentMeta | undefined): boolean {
    if (meta?.toolUseId && t.finishedTools.has(meta.toolUseId)) return true;
    if (t.finishedAgents.has(file.agentId)) return true;
    if (file.runId) {
      if (t.finishedRuns.has(file.runId)) return true;
      const tool = t.runToTool.get(file.runId);
      if (tool && t.finishedTools.has(tool)) return true;
      if (this.journal(t, file.runId).get(file.agentId)?.done) return true;
    }
    return false;
  }

  private journal(t: SessionTracker, runId: string): Map<string, JournalAgent> {
    if (!t.transcriptPath) return new Map();
    const path = join(sessionDirOf(t.transcriptPath), 'subagents', 'workflows', runId, 'journal.jsonl');
    let size = -1;
    try {
      size = statSync(path).size;
    } catch {
      // workflow without journal
    }
    const cached = t.journals.get(runId);
    if (cached && cached.size === size) return cached.agents;
    let agents = new Map<string, JournalAgent>();
    if (size >= 0) {
      try {
        agents = parseJournal(readFileSync(path, 'utf8'));
      } catch {
        // unreadable right now: retry on next cycle
      }
    }
    t.journals.set(runId, { size, agents });
    return agents;
  }

  private scanSubagents(t: SessionTracker, boot: boolean): void {
    if (!t.transcriptPath) return;
    const now = this.now();
    const busy = (t.entry.status !== 'idle' && t.entry.status !== 'shell') || t.subs.size > 0;
    if (!boot && !busy && now - t.lastSubScanAt < 5_000) return;
    t.lastSubScanAt = now;
    this.watchSubagents(t);
    const files = listSubagentFiles(sessionDirOf(t.transcriptPath));
    const workflowAgents = files.filter((f) => f.runId).length;
    if (workflowAgents !== t.workflowAgents) {
      t.workflowAgents = workflowAgents;
      this.applyMainSummary(t);
    }
    // First scan of session (boot or resumed session): only include recently written files —
    // or those still in the middle of a tool (e.g., long command, nothing written for minutes).
    const firstScan = !t.scanned;
    for (const file of files) {
      if (t.subs.has(file.agentId)) continue;
      let size: number;
      let mtimeMs: number;
      try {
        const st = statSync(file.path);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const known = t.known.get(file.path);
      if (known === undefined) {
        if (firstScan && now - mtimeMs > BOOT_RECENT_MS && !this.maybeStillRunning(t, file, now - mtimeMs)) {
          t.known.set(file.path, size);
          continue;
        }
        this.openSub(t, file, firstScan ? 'replay' : 'new');
      } else if (size > known) {
        this.openSub(t, file, 'regrown');
      }
    }
    t.scanned = true;
  }

  /**
   * Subagent quiet for more than BOOT_RECENT_MS on first scan, but may still be running:
   * its last message invoked a tool that has not yet replied (long command) or the workflow
   * journal says it started and has not finished. Final decision remains with openSub (isFinished and
   * concludedByIdle, which waits up to PENDING_TOOL_TIMEOUT_MS with pending tool).
   */
  private maybeStillRunning(t: SessionTracker, file: SubagentFile, quietMs: number): boolean {
    if (quietMs >= PENDING_TOOL_TIMEOUT_MS) return false;
    if (file.runId && !t.finishedRuns.has(file.runId)) {
      const j = this.journal(t, file.runId).get(file.agentId);
      if (j && !j.done) return true;
    }
    return pendingToolAtEnd(file.path);
  }

  /**
   * Places a subagent in the office. 'new' = file just appeared (everything is new);
   * 'replay' = already existed when opening the session; 'regrown' = written to again after leaving.
   */
  private openSub(t: SessionTracker, file: SubagentFile, mode: 'new' | 'replay' | 'regrown'): void {
    try {
      this.openSubUnsafe(t, file, mode);
    } catch (err) {
      // Problematic file: ignore until its size changes again.
      try {
        t.known.set(file.path, statSync(file.path).size);
      } catch {
        t.known.set(file.path, 0);
      }
      log.warnOnce(`sub-open:${file.path}`, tr('Subagent {0} skipped: {1}', [file.agentId, errMsg(err)]));
    }
  }

  private openSubUnsafe(t: SessionTracker, file: SubagentFile, mode: 'new' | 'replay' | 'regrown'): void {
    const office = this.opts.office;
    const now = this.now();
    const meta = readSubagentMeta(file.metaPath);
    const tail = new FileTail(file.path);
    // New and small file: seekTail returns 0 and reads everything; large: only the end.
    const start = tail.seekTail(this.tailBytes);
    const state = createTranscriptState({ trackPrefix: start > 0 });
    const id = `${t.sessionId}:${file.agentId}`;
    const results: LineResult[] = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) results.push(parseWatchedLine(state, line, { idPrefix: id, now }));
      if (!r.more) break;
    }
    const finished =
      this.isFinished(t, file, meta) ||
      (mode !== 'new' && concludedByIdle({ now, lastWriteAt: tail.mtimeMs, ended: state.ended, pendingTool: state.pendingTools.size > 0 }));
    if (finished) {
      t.known.set(file.path, tail.size);
      return;
    }
    const spawn = meta?.toolUseId ? t.spawns.get(meta.toolUseId) : undefined;
    const parentId = spawn && spawn.owner !== t.key && office.has(spawn.owner) && !office.isSubDone(spawn.owner) ? spawn.owner : t.key;
    const journalLabel = file.runId ? this.journal(t, file.runId).get(file.agentId)?.label : undefined;
    const title = meta?.description ?? spawn?.description ?? journalLabel;
    const background = meta?.requestShape ? meta.requestShape !== 'foreground' || !!spawn?.background : !!spawn?.background;
    const added = office.addSub({
      id,
      parentId,
      sessionId: t.sessionId,
      role: subagentRole(meta, spawn?.subagentType),
      title,
      background,
      startedAt: state.firstAt ?? now,
    });
    if (!added) return;
    t.known.delete(file.path);
    const sub: SubTracker = { agentId: file.agentId, id, file, meta, tail, state };
    t.subs.set(file.agentId, sub);
    for (const r of results) this.applyResult(t, id, r, mode === 'new');
    this.applySubSummary(sub);
    if (start > 0) this.queuePrefix(file.path, start, state, (_signals, _older, shellEvents) => {
      if (t.subs.get(file.agentId) !== sub) return;
      this.applySubSummary(sub);
      this.mergeOlderShells(t, id, shellEvents);
    });
  }

  private applySubSummary(sub: SubTracker): void {
    const s = sub.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.model) summary.model = s.model;
    if (s.effort) summary.effort = s.effort;
    if (s.gitBranch) summary.gitBranch = s.gitBranch;
    if (s.permissionMode) summary.permissionMode = s.permissionMode;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(sub.id, summary);
  }

  private pumpSubs(t: SessionTracker): void {
    const office = this.opts.office;
    const now = this.now();
    for (const sub of [...t.subs.values()]) {
      if (!office.has(sub.id)) {
        // Already left the office (grace period elapsed).
        t.subs.delete(sub.agentId);
        t.known.set(sub.file.path, sub.tail.size);
        continue;
      }
      sub.meta ??= readSubagentMeta(sub.file.metaPath);
      let fresh = 0;
      for (let i = 0; i < 4; i++) {
        let r;
        try {
          r = sub.tail.read();
        } catch (err) {
          log.warnOnce(`sub:${sub.id}`, tr('Subagent {0}: {1}', [sub.id, errMsg(err)]));
          break;
        }
        for (const line of r.lines) {
          const res = parseWatchedLine(sub.state, line, { idPrefix: sub.id, now });
          fresh += res.activities.length;
          this.applyResult(t, sub.id, res, true);
        }
        if (r.lines.length) this.applySubSummary(sub);
        if (!r.more) break;
      }
      if (office.isSubDone(sub.id)) {
        if (fresh > 0 && !this.isFinished(t, sub.file, sub.meta)) {
          const since = office.get(sub.id)?.statusSince ?? now;
          if (now - since > 3_000) office.reactivateSub(sub.id);
        }
        continue;
      }
      const done =
        this.isFinished(t, sub.file, sub.meta) ||
        concludedByIdle({ now, lastWriteAt: sub.tail.mtimeMs, ended: sub.state.ended, pendingTool: sub.state.pendingTools.size > 0 });
      if (done) {
        office.completeSub(sub.id);
        // Completed: nothing runs in foreground (background jobs transfer to main agent).
        t.shells.endForeground(sub.id, now);
      }
    }
  }

  // ---------------------------------------------------------------- fs.watch (accelerator)

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // unsupported/non-existent folder: covered by polling
    }
  }

  private addWatch(t: SessionTracker, path: string, recursive: boolean): boolean {
    try {
      const w = watch(path, { persistent: false, recursive }, () => this.schedule());
      w.on('error', () => w.close());
      t.watchers.push(w);
      return true;
    } catch {
      return false; // unsupported: covered by polling
    }
  }

  private watchSession(t: SessionTracker): void {
    if (!this.useWatch || !t.transcriptPath) return;
    this.addWatch(t, t.transcriptPath, false);
    this.watchSubagents(t);
  }

  private watchSubagents(t: SessionTracker): void {
    if (!this.useWatch || t.watchingSubs || !t.transcriptPath) return;
    const subDir = join(sessionDirOf(t.transcriptPath), 'subagents');
    if (existsSync(subDir)) t.watchingSubs = this.addWatch(t, subDir, true);
  }

  private closeWatchers(t: SessionTracker): void {
    for (const w of t.watchers) w.close();
    t.watchers = [];
    t.watchingSubs = false;
  }
}

/** End of transcript read to check for tool without result (without constructing activities). */
const PENDING_PROBE_BYTES = 256 * 1024;

/** Did the last transcript message call a tool that has not yet had a result? */
export function pendingToolAtEnd(path: string): boolean {
  try {
    const tail = new FileTail(path);
    tail.seekTail(PENDING_PROBE_BYTES);
    const state = createTranscriptState();
    for (let i = 0; i < 8; i++) {
      const r = tail.read();
      for (const line of r.lines) parseLine(state, line, { idPrefix: '', now: 0, activities: false });
      if (!r.more) break;
    }
    return state.pendingTools.size > 0 && !state.ended;
  } catch {
    return false;
  }
}

/** <session>/custom-title.json {"customTitle": "..."} (title given with /rename). */
export function readCustomTitleFile(sessionDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(sessionDir, 'custom-title.json'), 'utf8')) as { customTitle?: unknown };
    return typeof j.customTitle === 'string' && j.customTitle.trim() ? j.customTitle.trim() : undefined;
  } catch {
    return undefined;
  }
}
