// Shells that session agents are waiting on: background Bash (run_in_background, or
// sent to background mid-execution), foreground Bash still without result, and Monitor.
//
// One tracker per session (main + subagents): termination notification of a shell triggered
// by a subagent may arrive in main's transcript, and vice versa. Jobs are indexed by
// tool_use id; background task id ("bo0ov3q3l") arrives in tool_result.
//
// Termination: <task-notification> (queue-operation 'enqueue', user message or attachment) matching task-id
// or tool-use-id; TaskStop/KillShell/KillBash with id; turn end/interruption (foreground
// only); /clear or closed session (tracker discarded); age.
import type { ShellJob } from '../../shared/types';
import type { ShellOutcome } from '../../shared/activity';

/** Jobs older than this are dropped (the process is certainly dead or the notification was lost). */
export const SHELL_MAX_AGE_MS = 24 * 3_600_000;
/** Registry "idle" + background shell with no notification for less than this = 'shell' status (older CLIs). */
export const SHELL_FALLBACK_MAX_AGE_MS = 12 * 3_600_000;
/** Monitor: expires on its own after timeout_ms (default 5 min, ceiling 1 h) + this buffer. */
const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
const MONITOR_MAX_TIMEOUT_MS = 3_600_000;
const EXPIRY_GRACE_MS = 60_000;
/** Tolerance between transcript clock and process start time in registry. */
const PROCESS_START_SLACK_MS = 2_000;
/** Saved closed IDs (avoids resurrecting a job when re-reading transcript or merging file head). */
const MAX_ENDED = 2_000;
/** A repeated notification (queue -> message) up to this time after completion is still "from same exit". */
const RECENT_END_MS = 120_000;

/** Bash/Monitor start seen in transcript. */
export interface ShellStart {
  toolUseId: string;
  label: string;
  command?: string;
  /** run_in_background (Bash) or Monitor. */
  background: boolean;
  kind: 'shell' | 'monitor';
  /** tool_use epoch ms. */
  at: number;
  /** Monitor timeout_ms (expiration). */
  timeoutMs?: number;
}

export interface TrackedShell {
  owner: string;
  toolUseId: string;
  taskId?: string;
  label: string;
  command?: string;
  background: boolean;
  kind: 'shell' | 'monitor';
  /** Displayed start (actual launch, when tool_result of background job arrives). */
  startedAt: number;
  /** When tool_use was written (filter baseline: "prior to current process"). */
  requestedAt: number;
  timeoutMs?: number;
  /** Foreground waiting for approval: does not appear and its clock is paused. */
  held?: boolean;
}

export interface ShellFinish {
  job: TrackedShell;
  outcome: ShellOutcome;
  at: number;
  summary?: string;
}

export interface ShellRef {
  toolUseId?: string;
  taskId?: string;
}

const OK = /^(completed?|success|succeeded|done|finished|exited)$/i;
const FAILED = /^(failed|failure|error|errored|timeout|timed[_ -]?out)$/i;
const KILLED = /^(killed|stopped|cancell?ed|aborted|interrupted|terminated)$/i;

/**
 * Outcome of a notification: undefined = non-terminal (e.g. Monitor event). Without status,
 * a shell (Bash) sends only one notification — the completion; Monitor sends one per event.
 */
export function notificationOutcome(kind: 'shell' | 'monitor', status: string | undefined, summary: string | undefined): ShellOutcome | undefined {
  const s = status?.trim();
  const exit = summary ? /exit code (-?\d+)/i.exec(summary)?.[1] : undefined;
  if (s && OK.test(s)) return exit !== undefined && exit !== '0' ? 'failed' : 'ok';
  if (s && FAILED.test(s)) return 'failed';
  if (s && KILLED.test(s)) return 'killed';
  if (s || kind === 'monitor') return undefined;
  if (summary && /\b(killed|stopped|interrupted|cancell?ed)\b/i.test(summary)) return 'killed';
  if (summary && /\bfailed\b/i.test(summary)) return 'failed';
  return exit !== undefined && exit !== '0' ? 'failed' : 'ok';
}

export class ShellTracker {
  private jobs = new Map<string, TrackedShell>();
  private taskToTool = new Map<string, string>();
  /** Closed tool_use id / task id -> when. */
  private ended = new Map<string, number>();
  /** Launches whose tool_use is not in the read window (matched when merging file head). */
  private orphanLaunches = new Map<string, { taskId?: string; at: number }>();
  /** Shell IDs whose completion was already reported (notification/TaskStop) -> when. */
  private reported = new Map<string, number>();

  get size(): number {
    return this.jobs.size;
  }

  /** Bash/Monitor called. Ignores already terminated jobs (transcript re-read). */
  start(owner: string, s: ShellStart): void {
    if (this.jobs.has(s.toolUseId) || this.ended.has(s.toolUseId)) return;
    const job: TrackedShell = {
      owner,
      toolUseId: s.toolUseId,
      label: s.label,
      background: s.background,
      kind: s.kind,
      startedAt: s.at,
      requestedAt: s.at,
    };
    if (s.command) job.command = s.command;
    if (s.timeoutMs !== undefined) job.timeoutMs = s.timeoutMs;
    this.jobs.set(s.toolUseId, job);
    const orphan = this.orphanLaunches.get(s.toolUseId);
    if (orphan) {
      this.orphanLaunches.delete(s.toolUseId);
      this.launch(job, orphan.taskId, orphan.at);
    }
  }

  /**
   * Bash/Monitor tool_result. With background task ID (or if already background), the job
   * waits for notification; otherwise (foreground ended, error, denied) leaves list.
   */
  result(toolUseId: string, opts: { taskId?: string; error: boolean; at: number }): void {
    const job = this.jobs.get(toolUseId);
    if (!job) {
      if (opts.taskId && !opts.error && !this.ended.has(toolUseId)) {
        this.orphanLaunches.set(toolUseId, { taskId: opts.taskId, at: opts.at });
        if (this.orphanLaunches.size > 256) this.orphanLaunches.delete(this.orphanLaunches.keys().next().value as string);
      }
      return;
    }
    if (opts.error || (!job.background && !opts.taskId)) {
      this.remove(job, opts.at);
      return;
    }
    this.launch(job, opts.taskId, opts.at);
  }

  private launch(job: TrackedShell, taskId: string | undefined, at: number): void {
    if (taskId && this.ended.has(taskId)) {
      this.remove(job, at);
      return;
    }
    // Background request: actually starts on launch (after possible approval). Sent
    // to background mid-execution (foreground): continues counting from initial start.
    if (job.background) job.startedAt = Math.max(job.startedAt, at);
    job.background = true;
    delete job.held;
    if (taskId) {
      job.taskId = taskId;
      this.taskToTool.set(taskId, job.toolUseId);
    }
  }

  private find(ref: ShellRef): TrackedShell | undefined {
    if (ref.toolUseId) {
      const j = this.jobs.get(ref.toolUseId);
      if (j) return j;
    }
    if (ref.taskId) {
      const tool = this.taskToTool.get(ref.taskId);
      if (tool) return this.jobs.get(tool);
    }
    return undefined;
  }

  private markEnded(id: string | undefined, at: number): void {
    if (!id) return;
    this.ended.delete(id);
    this.ended.set(id, at);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.keys().next().value as string);
  }

  private remove(job: TrackedShell, at: number): void {
    this.jobs.delete(job.toolUseId);
    if (job.taskId) this.taskToTool.delete(job.taskId);
    this.markEnded(job.toolUseId, at);
    this.markEnded(job.taskId, at);
  }

  /** <task-notification>: returns completion (once only) of a known job. */
  notify(ref: ShellRef & { status?: string; summary?: string; at: number }): ShellFinish | undefined {
    const job = this.find(ref);
    if (!job) {
      // Unknown (subagent, or tool_use preceded read window): remember to avoid resurrection.
      if (!ref.status || OK.test(ref.status) || FAILED.test(ref.status) || KILLED.test(ref.status)) {
        this.markEnded(ref.toolUseId, ref.at);
        this.markEnded(ref.taskId, ref.at);
      }
      return undefined;
    }
    const outcome = notificationOutcome(job.kind, ref.status, ref.summary);
    if (!outcome) return undefined;
    this.remove(job, ref.at);
    this.markReported(job, ref.at);
    const fin: ShellFinish = { job, outcome, at: ref.at };
    if (ref.summary) fin.summary = ref.summary;
    return fin;
  }

  private markReported(job: TrackedShell, at: number): void {
    for (const id of [job.toolUseId, job.taskId]) {
      if (!id) continue;
      this.reported.set(id, at);
      if (this.reported.size > 256) this.reported.delete(this.reported.keys().next().value as string);
    }
  }

  /** TaskStop/KillShell/KillBash accepted. */
  stop(taskId: string, at: number): ShellFinish | undefined {
    const job = this.find({ taskId, toolUseId: taskId });
    if (!job) {
      this.markEnded(taskId, at);
      return undefined;
    }
    this.remove(job, at);
    this.markReported(job, at);
    return { job, outcome: 'killed', at };
  }

  /** Turn end or interruption: no foreground command continues running. */
  endForeground(owner: string | undefined, at: number): void {
    for (const job of [...this.jobs.values()]) if (!job.background && (owner === undefined || job.owner === owner)) this.remove(job, at);
  }

  /**
   * Session waiting for approval (registry 'waiting'): foreground commands have not started yet —
   * removed from list and their clock restarts when wait finishes.
   */
  holdForeground(waiting: boolean, now: number): void {
    for (const job of this.jobs.values()) {
      if (job.background) continue;
      if (waiting) {
        job.held = true;
        job.startedAt = Math.max(job.startedAt, now);
      } else delete job.held;
    }
  }

  /**
   * Was this shell's completion already reported recently (e.g. queue notified and now same
   * notification is delivered to agent)? Only applies to tracked shells (not subagents).
   */
  reportedRecently(ref: ShellRef, at: number): boolean {
    for (const id of [ref.toolUseId, ref.taskId]) {
      const t = id ? this.reported.get(id) : undefined;
      if (t !== undefined && Math.abs(at - t) <= RECENT_END_MS) return true;
    }
    return false;
  }

  /**
   * Drops jobs that cannot be running: > 24 h, prior to current Claude Code process
   * (shells die with it — e.g. resumed session), and monitors past their timeout.
   */
  prune(now: number, processStart?: number): boolean {
    let changed = false;
    for (const job of [...this.jobs.values()]) {
      let drop = now - job.requestedAt > SHELL_MAX_AGE_MS;
      if (processStart !== undefined && job.requestedAt < processStart - PROCESS_START_SLACK_MS) drop = true;
      if (job.kind === 'monitor') {
        const limit = Math.min(job.timeoutMs ?? MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS);
        if (now - job.startedAt > limit + EXPIRY_GRACE_MS) drop = true;
      }
      if (drop) {
        this.remove(job, now);
        changed = true;
      }
    }
    return changed;
  }

  /** Is there a background Bash running (started < `maxAgeMs` ago)? Monitors do not count (as in Claude Code). */
  hasBackgroundShell(now: number, maxAgeMs = SHELL_FALLBACK_MAX_AGE_MS): boolean {
    for (const job of this.jobs.values()) if (job.background && job.kind === 'shell' && now - job.startedAt < maxAgeMs) return true;
    return false;
  }

  /**
   * Registry (version recording "shell") reports no background shell running: any remainder
   * missed its notification. Drop background Bash (monitors excluded by Claude Code).
   */
  dropBackgroundShells(now: number): boolean {
    let changed = false;
    for (const job of [...this.jobs.values()]) {
      if (!job.background || job.kind !== 'shell') continue;
      this.remove(job, now);
      changed = true;
    }
    return changed;
  }

  /** Visible jobs (excluding foreground awaiting approval), from oldest to newest. */
  list(): TrackedShell[] {
    return [...this.jobs.values()].filter((j) => !j.held).sort((a, b) => a.startedAt - b.startedAt || a.toolUseId.localeCompare(b.toolUseId));
  }

  /**
   * Background jobs left open in file head (read after end window): included,
   * unless window already indicated their completion.
   */
  merge(jobs: readonly TrackedShell[]): boolean {
    let changed = false;
    for (const j of jobs) {
      if (!j.background || this.jobs.has(j.toolUseId) || this.ended.has(j.toolUseId) || (j.taskId && this.ended.has(j.taskId))) continue;
      const job: TrackedShell = { ...j };
      this.jobs.set(job.toolUseId, job);
      const orphan = this.orphanLaunches.get(job.toolUseId);
      if (orphan) {
        this.orphanLaunches.delete(job.toolUseId);
        this.launch(job, orphan.taskId, orphan.at);
      } else if (job.taskId) this.taskToTool.set(job.taskId, job.toolUseId);
      changed = true;
    }
    return changed;
  }

  /** Background jobs still open (for merging file head). */
  openBackground(): TrackedShell[] {
    return [...this.jobs.values()].filter((j) => j.background).map((j) => ({ ...j }));
  }
}

/** Published ShellJob (without internal fields). */
export function toShellJob(j: TrackedShell): ShellJob {
  const job: ShellJob = { id: j.taskId ?? j.toolUseId, label: j.label, startedAt: j.startedAt, background: j.background, kind: j.kind };
  if (j.command) job.command = j.command;
  return job;
}
