// Worker terminals: each registered worker (an Antigravity profile or a Claude Code account, server/team.ts) runs in a
// terminal of the office (PtyManager), which you can watch while the boss gives it jobs.
//
// A job (POST /api/workers/ask, from agy-ask / claude-ask or "Send a job") restarts the worker's terminal with the
// request as its first message (`agy-as accN -i "…"`, `claude --session-id <uuid> "…"`): one fresh conversation per job,
// mode and effort per job. The caller then waits (GET /api/workers/jobs/<id>?wait=60, no tokens spent while waiting)
// and gets only the final answer, read from the conversation file (server/workers/turns.ts), never the screen, up to
// `max` characters. After the job the terminal stays open to read until it idles out: every job is a new conversation,
// so there is nothing to continue in it and nobody types there (only sessions you open in a terminal yourself).
//
// One session per account at a time: a worker on a job refuses new ones (BUSY) and the caller asks again later.
//
// Jobs go to the agy-ask log (start/end lines with via "terminal": level, tokens and news, as before) and to the room's
// job board (with their WorkerJob id, so the board can cancel them).
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { JobBoardItem, PtyInfo, WorkerJob, WorkerKind, WorkerSession } from '../../shared/types';
import { maskSecrets, truncate } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import { agyTranscriptPath, agyTurn, claudeTranscriptPath, claudeTrusts, claudeTurn, type TurnState } from './turns';

/** Characters of the answer sent back by default. */
export const ANSWER_MAX = 2_000;
/** A job that does not end within this time is stopped (TIMEOUT). */
export const JOB_TIMEOUT_MS = 30 * 60_000;
/** Jobs kept in the snapshot (newest first). */
export const JOBS_KEPT = 50;
/** Longest wait of one GET (the CLI loops). */
export const WAIT_MAX_S = 60;
/** A worker terminal left idle this long (no job) is closed. */
export const IDLE_CLOSE_MS = 20 * 60_000;
/** How often running jobs are checked. */
const TICK_MS = 1_000;
/** Waiting for an old terminal of the same account to close before starting another one. */
const CLOSE_WAIT_MS = 8_000;
const ESC = '\x1b';
/** A Claude job whose conversation has not started by then, in a folder its account does not trust, is stopped. */
export const TRUST_WAIT_MS = 15_000;
/**
 * Tools of a lean Claude Code worker. The default set costs ~24k tokens of context per job before any work (mostly
 * the Workflow and Agent tools); this one ~8k. Same list and rule as claude-ask's headless path (agy-hub bin/worker-ask).
 */
export const LEAN_TOOLS = 'Bash,Read,Edit,Write,WebFetch,WebSearch';

/** --settings that make a Claude Code worker run agy-hub's rules-hook before the tools the office rules check. */
export function rulesHookSettings(hook: string): string {
  const command = /^[\w./~-]+$/.test(hook) ? hook : `'${hook.replace(/'/g, "'\\''")}'`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|Bash', hooks: [{ type: 'command', command, timeout: 10 }] }] } });
}

/** The task without the office rules agy-ask puts on top of it ("Office rules of …", a blank line, the task). */
export function taskOf(prompt: string): string {
  const cut = prompt.startsWith('Office rules of "') ? prompt.indexOf('\n\n') : -1;
  return cut >= 0 ? prompt.slice(cut + 2) : prompt;
}

/** Flags for a lean Claude Code job: no MCP servers, no skills or slash commands, LEAN_TOOLS, a short worker rule. */
export function leanClaudeArgs(max: number): string[] {
  const rule =
    'You are a worker: another agent gave you this one job and reads only your final message. Do the job, then reply ' +
    `with just the result, compact (no preamble, no recap of your steps), under ${max} characters. ` +
    'If you could not do it, say so plainly and why.';
  return ['--strict-mcp-config', '--disable-slash-commands', '--tools', LEAN_TOOLS, '--append-system-prompt', rule];
}

export interface WorkerTarget {
  id: string;
  kind: WorkerKind;
  /** Its character in the office. */
  agentId: string;
  /** AccountInfo.id. */
  account: string;
  name: string;
  /** Antigravity: profile (accN) and agy state dir (<profile>/.gemini/antigravity-cli). */
  acc?: string;
  stateDir?: string;
  /** Claude Code: config dir (CLAUDE_CONFIG_DIR, unless `isDefault`). */
  configDir?: string;
  isDefault?: boolean;
  /**
   * Its character in each office that has it (server/team.ts seats; the first one is `agentId`): a job shows on the
   * seat of the office that gave it. Absent = one character, `agentId`, in the workers room.
   */
  seats?: Array<{ office: string; agentId: string; name: string; room: string }>;
}

export interface AskInput {
  worker: string;
  prompt: string;
  cwd?: string;
  role?: string;
  mode?: string;
  effort?: string;
  /** Model for this job (agy: only Gemini 3.8 Flash names; Claude Code: an alias like "haiku" or a full name). */
  model?: string;
  max?: number;
  /** Claude Code workers: start lean (no MCP servers, skills or slash commands, LEAN_TOOLS only, worker rule). */
  lean?: boolean;
  by?: WorkerJob['by'];
  callerPid?: number;
  /** OfficeInfo.id of the office giving the job (the worker must be one of its workers). */
  office?: string;
}

export type AskResult = { ok: true; job: WorkerJob } | { ok: false; status: number; error: string; busy?: 'job' };

/** What the service needs from the terminal manager. */
export interface WorkerPtys {
  openProgram(p: { agentId: string; account: string; file: string; args: string[]; cwd: string; env?: Record<string, string>; onExit?: (code: number) => void }): PtyInfo;
  ofAgent(agentId: string): PtyInfo | undefined;
  typeTo(agentId: string, data: string): boolean;
  closeAgent(agentId: string): void;
}

export interface WorkerServiceOptions {
  office: Office;
  ptys: WorkerPtys;
  /** The registered workers now. */
  targets: () => WorkerTarget[];
  agyBin: string;
  claudeBin: string;
  /** agy-hub bin/rules-hook: a Claude worker's job for an office runs it as its PreToolUse hook (office rules). */
  rulesHook?: string;
  /** Folder of a job without `cwd` (the workers room). */
  room: string;
  /** ~/.agy_profiles/agy-ask.log.jsonl. */
  logFile: string;
  /** Remembered conversations per worker (<dataDir>/workers.json). */
  stateFile?: string;
  /** The team in the snapshot changed (sessions, jobs). */
  onChange: () => void;
  /** Offices (server/team.ts): is the worker one of that office's, and which office a job without one goes to. */
  offices?: { has: (worker: string, office: string) => boolean; of: (worker: string) => string | undefined };
  /** Adds or updates a job on the room's board. */
  board?: (item: JobBoardItem) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Job extends WorkerJob {
  model?: string;
  max: number;
  lean?: boolean;
  /** Claude: the folder's trust was checked (TRUST_WAIT_MS after the start, no conversation yet). */
  trustChecked?: boolean;
  cwd: string;
  callerPid?: number;
  /** Agent id of the worker's character. */
  agentId: string;
  ptyPid?: number;
  /** Conversation id (agy: found once its folder appears; Claude: chosen). */
  conv?: string;
  /** Before the conversation shows up: the agy conversations that already existed. */
  known?: Set<string>;
  deadline: number;
  size: number;
  turn?: TurnState;
}

interface Session {
  t: WorkerTarget;
  job?: Job;
  /** Last time it had a job or a new terminal (idle terminals close after IDLE_CLOSE_MS). */
  activeAt: number;
}

type Waiter = () => void;

export class WorkerService {
  private readonly sessions = new Map<string, Session>();
  private jobList: Job[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly jobWaiters = new Map<string, Set<Waiter>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Workers whose terminal is being (re)started: a second request waits for the first. */
  private readonly starting = new Set<string>();

  constructor(private readonly opts: WorkerServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  start(): void {
    this.sync();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`workers:${errMsg(err)}`, tr('Worker terminals: {0}', [errMsg(err)]));
      }
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ views

  sessionList(): WorkerSession[] {
    this.sync();
    return [...this.sessions.values()].map((s) => {
      const out: WorkerSession = { worker: s.t.id, kind: s.t.kind, agentId: s.t.agentId, account: s.t.account };
      if (s.t.seats?.length) out.agentIds = Object.fromEntries(s.t.seats.map((x) => [x.office, x.agentId]));
      const pty = this.opts.ptys.ofAgent(s.t.agentId);
      if (pty) out.ptyId = pty.id;
      if (s.job && live(s.job)) out.job = s.job.id;
      return out;
    });
  }

  jobs(): WorkerJob[] {
    return this.jobList.map(view);
  }

  job(id: string): WorkerJob | undefined {
    const j = this.jobList.find((x) => x.id === id);
    return j && view(j);
  }

  /** For the worker's character: a job is running. */
  statusOf(worker: string, office?: string): { busy: boolean; role?: string } | undefined {
    const s = this.sessions.get(worker);
    if (!s) return undefined;
    // A job shows on the seat of the office that gave it (office undefined = any).
    const busy = !!s.job && live(s.job) && (office === undefined || this.officeOfJob(s, s.job) === office);
    return { busy, ...(busy && s.job!.role ? { role: s.job!.role } : {}) };
  }

  /** Is this PID the program of a worker terminal? (ClaudeWatcher leaves those sessions to this service.) */
  ownsPid(pid: number): boolean {
    for (const s of this.sessions.values()) if (this.opts.ptys.ofAgent(s.t.agentId)?.pid === pid) return true;
    return false;
  }

  // ------------------------------------------------------------------ jobs

  async ask(input: AskInput): Promise<AskResult> {
    this.sync();
    const s = this.sessions.get(input.worker);
    // 400, not 404: agy-ask / claude-ask run a job headless on 404 (an office without worker terminals).
    if (!s) return { ok: false, status: 400, error: tr('{0} is not a registered worker', [input.worker]) };
    if (input.office && this.opts.offices && !this.opts.offices.has(s.t.id, input.office)) return { ok: false, status: 400, error: tr('{0} is not a worker of this office', [s.t.name]) };
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 20_000) return { ok: false, status: 400, error: tr('prompt empty or too long') };
    if (input.cwd !== undefined && (!isAbsolute(input.cwd) || !isDir(input.cwd))) return { ok: false, status: 400, error: tr('folder not found: {0}', [input.cwd]) };
    if ((s.job && live(s.job)) || this.starting.has(s.t.id)) return { ok: false, status: 409, busy: 'job', error: tr('{0} is busy with another job', [s.t.name]) };
    const now = this.now();
    const job: Job = {
      id: `w${now.toString(36)}${(++this.seq).toString(36)}`,
      worker: s.t.id,
      agentId: s.t.agentId,
      prompt: truncate(maskSecrets(taskOf(prompt).replace(/\s+/g, ' ')), 300),
      by: input.by ?? 'script',
      status: 'working',
      startedAt: now,
      max: Math.max(200, Math.min(input.max ?? ANSWER_MAX, 20_000)),
      cwd: input.cwd ?? this.opts.room,
      deadline: now + JOB_TIMEOUT_MS,
      size: -1,
    };
    if (input.role) job.role = input.role;
    if (input.mode && input.mode !== 'default') job.mode = input.mode;
    if (input.effort) job.effort = input.effort;
    if (input.model) job.model = input.model;
    if (input.lean) job.lean = true;
    if (input.callerPid) job.callerPid = input.callerPid;
    const office = input.office ?? this.opts.offices?.of(s.t.id);
    if (office) job.office = office;
    // The job shows on the character of the office that gave it.
    job.agentId = s.t.seats?.find((x) => x.office === office)?.agentId ?? s.t.agentId;
    s.job = job;
    this.jobList = [job, ...this.jobList].slice(0, JOBS_KEPT);
    this.starting.add(s.t.id);
    try {
      // Cancelled while the old terminal was closing: nothing to start.
      await this.restart(s, () => (live(job) ? this.jobProgram(s, job, prompt) : undefined));
    } catch (err) {
      this.finish(job, 'failed', 'ERROR', errMsg(err));
      return { ok: false, status: 500, error: errMsg(err) };
    } finally {
      this.starting.delete(s.t.id);
    }
    if (!live(job)) return { ok: true, job: view(job) };
    this.writeLog({ event: 'start', ts: job.startedAt / 1000, acc: s.t.id, role: job.role, mode: job.mode, effort: job.effort, claude_pid: job.by === 'boss' ? (job.callerPid ?? null) : null, pid: job.ptyPid, prompt: prompt.slice(0, 200), via: 'terminal', worker: s.t.id, job: job.id, ...(job.office ? { office: job.office } : {}) });
    this.toBoard(job);
    this.opts.office.addActivity(s.t.agentId, { id: `${job.id}:start`, at: now, kind: 'prompt', icon: '📋', text: truncate(job.prompt, 40), detail: job.prompt }, true);
    this.changed(s);
    return { ok: true, job: view(job) };
  }

  /** The job, once it is over or after `waitS` seconds (whichever comes first). */
  async waitJob(id: string, waitS: number): Promise<WorkerJob | undefined> {
    const j = this.jobList.find((x) => x.id === id);
    if (!j) return undefined;
    if (live(j) && waitS > 0) await this.waitOn(this.jobWaiters, id, Math.min(waitS, WAIT_MAX_S) * 1000);
    return view(j);
  }

  /** Cancels a job, every job of a worker, or every job. Returns how many were running. */
  cancel(p: { job?: string; worker?: string; office?: string; all?: boolean }): number {
    let n = 0;
    for (const j of this.jobList) {
      if (!live(j)) continue;
      if (!(p.all || (p.job && j.id === p.job) || (p.worker && j.worker === p.worker) || (p.office && j.office === p.office))) continue;
      const s = this.sessions.get(j.worker);
      if (s) this.interrupt(s, j, 'cancelled', 'CANCELLED', tr('cancelled by you'));
      else this.finish(j, 'cancelled', 'CANCELLED', tr('cancelled by you'));
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Sessions follow the registered workers; a worker that leaves loses its job and terminal. Claude workers get their
   * character here (Antigravity ones come from sources/agy).
   */
  sync(): void {
    const targets = this.opts.targets();
    for (const t of targets) {
      const s = this.sessions.get(t.id);
      if (s) s.t = t;
      else {
        this.sessions.set(t.id, { t, activeAt: this.now() });
      }
    }
    for (const [id, s] of [...this.sessions]) {
      if (targets.some((t) => t.id === id)) continue;
      this.cancel({ worker: id });
      this.opts.ptys.closeAgent(s.t.agentId);
      this.sessions.delete(id);
    }
    this.syncClaudeCharacters();
  }

  /** The seats of a target: its offices' characters, else its one character in the workers room. */
  private seatsOf(t: WorkerTarget): Array<{ office?: string; agentId: string; name: string; room: string }> {
    return t.seats?.length ? t.seats : [{ agentId: t.agentId, name: t.name, room: this.opts.room }];
  }

  /** Claude workers' characters, one per seat: added when a seat appears, sent away when it goes. */
  private syncClaudeCharacters(): void {
    const want = new Map<string, { s: Session; seat: { office?: string; agentId: string; name: string; room: string } }>();
    for (const s of this.sessions.values()) if (s.t.kind === 'claude') for (const seat of this.seatsOf(s.t)) want.set(seat.agentId, { s, seat });
    for (const [agentId, { s, seat }] of want) {
      if (this.claudeShown.has(agentId)) continue;
      this.claudeShown.add(agentId);
      this.opts.office.addMain({ id: agentId, account: s.t.account, sessionId: agentId, cwd: seat.room, role: tr('Worker'), name: seat.name, startedAt: this.now(), status: 'idle' });
      this.showClaude(s);
    }
    for (const agentId of [...this.claudeShown]) {
      if (want.has(agentId)) continue;
      this.claudeShown.delete(agentId);
      this.opts.office.closeMain(agentId);
    }
  }

  /** Claude worker characters in the office now. */
  private readonly claudeShown = new Set<string>();

  /** The office a job belongs to (its own, else the worker's first seat). */
  private officeOfJob(s: Session, j: Job): string | undefined {
    return j.office ?? s.t.seats?.[0]?.office;
  }

  /** Status and subtitle of a Claude worker's character. */
  private showClaude(s: Session): void {
    if (s.t.kind !== 'claude') return;
    const office = this.opts.office;
    for (const seat of this.seatsOf(s.t)) {
      const busy = !!s.job && live(s.job) && (seat.office === undefined || this.officeOfJob(s, s.job) === seat.office);
      if (office.get(seat.agentId)?.status !== (busy ? 'working' : 'idle')) office.setStatus(seat.agentId, busy ? 'working' : 'idle');
      const title = busy ? (s.job!.role ?? tr('job')) : tr('free');
      office.applyTranscript(seat.agentId, { title, tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: busy ? (s.job?.tokens ?? 0) : 0, subagents: 0 } });
    }
  }

  tick(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const j = s.job;
      if (j && live(j)) s.activeAt = now;
      else if (now - s.activeAt > IDLE_CLOSE_MS && this.opts.ptys.ofAgent(s.t.agentId)) {
        this.opts.ptys.closeAgent(s.t.agentId);
        this.changed(s);
      }
      if (!j || !live(j)) continue;
      // Not started yet: the old terminal is still closing (the one that shows now is not the job's).
      if (j.ptyPid === undefined) continue;
      const pty = this.opts.ptys.ofAgent(s.t.agentId);
      if (!pty || (j.ptyPid !== undefined && pty.pid !== j.ptyPid)) {
        this.finish(j, 'failed', 'ERROR', tr('the terminal closed before the answer'));
        continue;
      }
      if (now > j.deadline) {
        this.interrupt(s, j, 'failed', 'TIMEOUT', tr('no answer after {0} min', [Math.round(JOB_TIMEOUT_MS / 60_000)]));
        continue;
      }
      this.check(s, j);
    }
  }

  /** Reads the job's conversation and ends the job if its turn is over. */
  private check(s: Session, j: Job): void {
    const path = this.transcriptOf(s, j);
    if (!path) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      this.checkTrust(s, j);
      return;
    }
    if (size === j.size) return;
    j.size = size;
    const turn = s.t.kind === 'agy' ? agyTurn(readFileSync(path, 'utf8')) : claudeTurn(readFileSync(path, 'utf8'));
    j.turn = turn;
    if (turn.ended) {
      j.answer = truncate((turn.answer ?? '').trim(), j.max);
      this.finish(j, 'done', 'SUCCESS');
    }
  }

  /**
   * A Claude job that has not started its conversation yet: if the account does not trust the folder, claude is
   * waiting at the trust dialog (it would wait until the timeout). Esc closes it; the job fails saying what to do.
   * Trust is never given for the user.
   */
  private checkTrust(s: Session, j: Job): void {
    if (s.t.kind !== 'claude' || j.trustChecked || this.now() - j.startedAt < TRUST_WAIT_MS) return;
    j.trustChecked = true;
    if (claudeTrusts(s.t.configDir!, !!s.t.isDefault, j.cwd) !== false) return;
    this.opts.ptys.typeTo(s.t.agentId, ESC);
    this.finish(j, 'failed', 'ERROR', tr('{0} does not trust the folder {1}: open claude there once with this account and answer yes, or give the job another folder', [s.t.name, j.cwd]));
  }

  /**
   * Stops a running job: Esc interrupts its turn. The conversation is read first, because a job that has just ended
   * is done (with its answer), and Esc at an idle agy prompt quits agy.
   */
  private interrupt(s: Session, j: Job, status: WorkerJob['status'], logStatus: string, error: string): void {
    this.check(s, j);
    if (!live(j)) return;
    this.opts.ptys.typeTo(s.t.agentId, ESC);
    this.finish(j, status, logStatus, error);
  }

  /** Where the job's conversation is written (agy: once its folder shows up). */
  private transcriptOf(s: Session, j: Job): string | undefined {
    if (s.t.kind === 'claude') return j.conv ? claudeTranscriptPath(s.t.configDir!, j.cwd, j.conv) : undefined;
    if (!j.conv) {
      // Without the folders listed before agy started, any old conversation would look new.
      if (!j.known) return undefined;
      const fresh = newDirs(join(s.t.stateDir!, 'brain'), j.known);
      if (!fresh) return undefined;
      j.conv = fresh;
    }
    return agyTranscriptPath(s.t.stateDir!, j.conv);
  }

  /** Closes the worker's terminal (waiting for it to end: one agy per profile) and opens another. */
  private async restart(s: Session, open: () => PtyInfo | undefined): Promise<void> {
    const agentId = s.t.agentId;
    s.activeAt = this.now();
    if (this.opts.ptys.ofAgent(agentId)) {
      this.opts.ptys.closeAgent(agentId);
      const until = this.now() + CLOSE_WAIT_MS;
      while (this.opts.ptys.ofAgent(agentId) && this.now() < until) await this.sleep(200);
      if (this.opts.ptys.ofAgent(agentId)) throw new WorkerError(409, tr('the previous terminal of {0} did not close', [s.t.name]));
    }
    open();
  }

  private jobProgram(s: Session, j: Job, prompt: string): PtyInfo {
    const t = s.t;
    if (t.kind === 'agy') {
      j.known = dirSet(join(t.stateDir!, 'brain'));
      const args = [t.acc!, '-i', prompt];
      if (j.mode) args.push('--mode', j.mode);
      if (j.effort) args.push('--effort', j.effort);
      if (j.model) args.push('--model', j.model);
      // For agy-hub's agy-plugin/office-rules (rules-hook), once it is installed in the profile.
      const info = this.open(s, args, j.cwd, j.office ? { AGY_OFFICE: j.office, AGY_WORKER: t.id } : undefined);
      j.ptyPid = info.pid;
      return info;
    }
    j.conv = randomUUID();
    const args = ['--session-id', j.conv];
    if (j.mode) args.push('--permission-mode', j.mode === 'accept-edits' ? 'acceptEdits' : j.mode);
    if (j.effort) args.push('--effort', j.effort);
    if (j.model) args.push('--model', j.model);
    if (j.lean) args.push(...leanClaudeArgs(j.max));
    // Office rules: rules-hook finds the office and the worker from AGY_OFFICE / AGY_WORKER.
    const rules = j.office && this.opts.rulesHook ? { AGY_OFFICE: j.office, AGY_WORKER: t.id } : undefined;
    if (rules) args.push('--settings', rulesHookSettings(this.opts.rulesHook!));
    args.push(prompt);
    const info = this.open(s, args, j.cwd, rules);
    j.ptyPid = info.pid;
    return info;
  }

  private open(s: Session, args: string[], cwd: string, extraEnv?: Record<string, string>): PtyInfo {
    const t = s.t;
    const env: Record<string, string> = { ...extraEnv };
    if (t.kind === 'claude' && !t.isDefault && t.configDir) env.CLAUDE_CONFIG_DIR = t.configDir;
    return this.opts.ptys.openProgram({
      agentId: t.agentId,
      account: t.account,
      file: t.kind === 'agy' ? this.opts.agyBin : this.opts.claudeBin,
      args,
      cwd,
      env,
      onExit: () => this.changed(s),
    });
  }

  private finish(j: Job, status: WorkerJob['status'], logStatus: string, error?: string): void {
    if (!live(j)) return;
    j.status = status;
    j.endedAt = this.now();
    if (error) j.error = error;
    if (j.turn?.tokens) j.tokens = j.turn.tokens;
    const sec = Math.round((j.endedAt - j.startedAt) / 1000);
    const end: Record<string, unknown> = { event: 'end', ts: j.endedAt / 1000, acc: j.worker, pid: j.ptyPid, status: logStatus, sec, via: 'terminal', worker: j.worker, job: j.id, ...(j.office ? { office: j.office } : {}) };
    if (j.tokens) end.usage = { ...(j.turn?.usage ?? {}), total_tokens: j.tokens };
    if (error && status === 'failed') end.error = error;
    this.writeLog(end);
    this.toBoard(j);
    const s = this.sessions.get(j.worker);
    const act =
      status === 'done'
        ? { kind: 'done' as const, icon: '✅', text: j.tokens ? tr('Done in {0}s · {1} tokens', [sec, j.tokens]) : tr('Done in {0}s', [sec]), detail: truncate(j.answer ?? '', 300) }
        : { kind: 'done' as const, icon: status === 'cancelled' ? '🚫' : '⚠️', text: status === 'cancelled' ? tr('Cancelled') : tr('Failed: {0}', [logStatus]), detail: error ?? '', error: status === 'failed' };
    this.opts.office.addActivity(j.agentId, { id: `${j.id}:end`, at: j.endedAt, durationMs: j.endedAt - j.startedAt, ...act }, true);
    this.notify(this.jobWaiters, j.id);
    if (s) this.changed(s);
  }

  private toBoard(j: Job): void {
    const s = this.sessions.get(j.worker);
    const item: JobBoardItem = {
      id: `${j.agentId}#${j.id}`,
      agentId: j.agentId,
      worker: s?.t.name ?? j.worker,
      text: j.prompt || tr('New job'),
      status: j.status === 'queued' ? 'working' : j.status,
      by: j.by,
      at: j.startedAt,
      job: j.id,
      workerId: j.worker,
    };
    if (j.office) item.office = j.office;
    if (j.role) item.role = j.role;
    if (j.endedAt) item.endedAt = j.endedAt;
    if (j.tokens) item.tokens = j.tokens;
    this.opts.board?.(item);
  }

  private changed(s: Session): void {
    this.showClaude(s);
    this.opts.onChange();
  }

  private waitOn(map: Map<string, Set<Waiter>>, key: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      const fire: Waiter = () => {
        clearTimeout(timer);
        set!.delete(fire);
        resolve();
      };
      const timer = setTimeout(() => {
        set!.delete(fire);
        resolve();
      }, ms);
      timer.unref?.();
      set.add(fire);
    });
  }

  private notify(map: Map<string, Set<Waiter>>, key: string): void {
    for (const w of [...(map.get(key) ?? [])]) w();
  }

  private writeLog(line: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.opts.logFile), { recursive: true });
      appendFileSync(this.opts.logFile, `${JSON.stringify(line)}\n`);
    } catch {
      // no log: the job still answers
    }
  }
}

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const live = (j: WorkerJob): boolean => j.status === 'queued' || j.status === 'working';

function view(j: Job): WorkerJob {
  const out: WorkerJob = { id: j.id, worker: j.worker, prompt: j.prompt, by: j.by, status: j.status, startedAt: j.startedAt };
  for (const k of ['office', 'role', 'mode', 'effort', 'endedAt', 'answer', 'error', 'tokens'] as const) if (j[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = j[k];
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dirSet(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

/** A folder in `dir` that was not there before (the conversation agy just created). */
function newDirs(dir: string, known: Set<string>): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  return names.find((n) => !known.has(n) && /^[0-9a-f-]{36}$/.test(n));
}
