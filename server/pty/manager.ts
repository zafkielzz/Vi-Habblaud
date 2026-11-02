// Interactive terminal: Habblaud opens Claude Code inside a pseudo-terminal (node-pty) and the browser displays
// and controls this terminal (xterm.js). Output via SSE on GET /api/pty/:id/stream; input, resizing, and
// termination via POST (routes in http/pty.ts).
//
// Three use cases: new session in a directory; "take over" an open session from another terminal (the process there
// is terminated and the same conversation continues here with `claude --resume`); and terminating an agent, whether
// here or in another terminal (only processes confirmed by Claude Code session registry as a session and whose start
// and executable match the registry: pty/procinfo.ts).
//
// Security: anyone controlling one of these terminals executes commands on the machine. The feature is opt-in
// (HABBLAUD_PTY=1), routes only accept connections from localhost (see http/pty.ts), and it is disabled in Docker.
import { chmodSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PtyInfo, PtyStatus } from '../../shared/types';
import { frame } from '../http/sse';
import { errMsg, log } from '../log';
import { pidAlive } from '../sources/registry';
import { readProcInfo, sameProcess, type ProcInfo, type RegisteredProc } from './procinfo';
import { killWithConsoleReset } from './winkill';
import { tr } from '../../shared/i18n';
import { isExecutableFile } from '../claude-bin';

export { claudeBinFrom, findExecutable, isExecutableFile } from '../claude-bin';

/** What the manager uses from node-pty (allows swapping in tests). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyProcess;

export interface PtyAccount {
  id: string;
  /** Account config directory (becomes CLAUDE_CONFIG_DIR, except for default). */
  dir: string;
  isDefault: boolean;
}

/** What the manager needs to know about a main agent to terminate or take it over. */
export interface PtyAgentRef {
  id: string;
  kind: 'main' | 'sub';
  account: string;
  sessionId: string;
  cwd?: string;
}

/**
 * Screen of a terminal on the server: receives output and returns, for clients connecting later (or switching tabs), a
 * sequence that reconstructs current screen with modes enabled by the program (bracketed paste, application keys,
 * alternate screen). `write` may process asynchronously: callback notifies when that chunk has been applied.
 */
export interface PtyScreen {
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  serialize(): string;
  dispose(): void;
}

export type ScreenFactory = (cols: number, rows: number) => PtyScreen;

/** Interactive agy of an Antigravity worker (sources/agy/): `agy-as <acc>` in the Antigravity room. */
export interface PtyAgy {
  /** The agy-as script (runs agy confined to the account profile). */
  bin: string;
  /** Folder the terminal opens in (the Antigravity room). */
  cwd: string;
  /** Worker in the office with this agent id: its profile (accN) and account id. */
  worker: (agentId: string) => { acc: string; account: string } | undefined;
}

export interface PtyManagerOptions {
  spawn: SpawnPty | null;
  /** Why the feature is disabled (when `spawn` is null). */
  disabledReason?: string;
  claudeBin: string;
  /** Antigravity workers (absent = none in the office). */
  agy?: PtyAgy;
  accounts: () => PtyAccount[];
  agent: (id: string) => PtyAgentRef | undefined;
  onChange: () => void;
  /**
   * "Take over" an agent that is not a Claude Code session but has a terminal of its own to reopen (the Antigravity
   * boss): returns that terminal, or undefined for the usual takeover.
   */
  reopen?: (agentId: string) => PtyInfo | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Terminates an external process (tests). Default: on Windows, terminates and cleans up terminal modes
   * (pty/winkill.ts, which rechecks exact start time); elsewhere, SIGTERM (Claude Code exits and cleans up itself).
   */
  killPid?: (pid: number, proc: ProcInfo) => void | Promise<void>;
  /** Force-kills if process does not exit in time during takeover (default: SIGKILL; on Windows, TerminateProcess). */
  forceKill?: (pid: number) => void;
  /** Start time and executable of a running process (default: pty/procinfo.ts). */
  procInfo?: (pid: number) => Promise<ProcInfo | undefined>;
  /** Reads `<account>/sessions/<pid>.json` (tests). */
  readSession?: (accountDir: string, pid: number) => unknown;
  /** Screen for each terminal, replayed to connecting clients (default: raw output only; see pty/screen.ts). */
  createScreen?: ScreenFactory;
  isAlive?: (pid: number) => boolean;
  /** Sends a signal to a terminal's program that ignored closing (tests; default: process.kill). */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Raw output retained per terminal when @xterm/headless is absent (see rawScreen). */
const MAX_SCROLLBACK = 512 * 1024;
/** Exited terminals stay in the list for a while so the final screen can still be viewed. */
const EXITED_KEEP_MS = 10 * 60_000;
export const MAX_PTYS = 12;
/** How long to wait for external process to exit before resuming session here (afterwards, force-killed). */
const TAKEOVER_WAIT_MS = 5_000;
/** After force-killing: how much longer to wait. */
const FORCE_WAIT_MS = 3_000;
/** Closing a terminal whose program ignored SIGHUP: when to send SIGTERM (then SIGKILL after FORCE_WAIT_MS). */
const KILL_TERM_MS = 2_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Agent id of a sign-in terminal (openLogin): "login:<account>". */
export const LOGIN_PREFIX = 'login:';
/** Main agent id: "<account>:<pid>". */
const MAIN_ID = /^(.+):(\d+)$/;

/**
 * Variables that Claude Code injects into its tools' environment. If Habblaud was started from inside
 * a session, Claude opened here would think it is a child session (and would disable the transcript).
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
];

/**
 * Without @xterm/headless: stores raw output, trimmed at line starts (never in the middle of an escape
 * sequence). Modes enabled at the beginning may be lost on replay.
 */
export function rawScreen(): PtyScreen {
  let buffer = '';
  return {
    write(data, done) {
      buffer += data;
      if (buffer.length > MAX_SCROLLBACK) {
        const cut = buffer.indexOf('\n', buffer.length - MAX_SCROLLBACK);
        buffer = cut === -1 ? '' : buffer.slice(cut + 1);
      }
      done?.();
    },
    resize() {},
    serialize: () => buffer,
    dispose() {
      buffer = '';
    },
  };
}

interface Pty {
  info: PtyInfo;
  proc: PtyProcess;
  screen: PtyScreen;
  clients: Set<ServerResponse>;
  /** Connecting: queues incoming output until the stored screen is ready. */
  pending: Map<ServerResponse, string[]>;
}

/** Verified session running in another terminal: PID and system proc info. */
interface ExternalProc {
  pid: number;
  proc: ProcInfo;
}

/** Requirements for a new session, already validated (directory, account, and dimensions). */
interface SpawnPlan {
  cwd: string;
  account: PtyAccount;
  cols: number;
  rows: number;
}

export class PtyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PtyManager {
  private ptys = new Map<string, Pty>();
  private seq = 0;
  /** Takeovers in progress per agent: a double click (or two tabs) receives the same promise. */
  private takeovers = new Map<string, Promise<PtyInfo>>();
  private readonly now: () => number;
  private readonly killPid: (pid: number, proc: ProcInfo) => void | Promise<void>;
  private readonly forceKill: (pid: number) => void;
  private readonly procInfo: (pid: number) => Promise<ProcInfo | undefined>;
  private readonly readSession: (accountDir: string, pid: number) => unknown;
  private readonly createScreen: ScreenFactory;
  private readonly isAlive: (pid: number) => boolean;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PtyManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.procInfo = opts.procInfo ?? ((pid) => readProcInfo(pid));
    this.killPid =
      opts.killPid ??
      (process.platform === 'win32'
        ? (pid, proc) => killWithConsoleReset(pid, proc.fileTime ?? '', () => this.stillSame(pid, proc))
        : (pid) => void process.kill(pid, 'SIGTERM'));
    this.forceKill = opts.forceKill ?? ((pid) => void process.kill(pid, 'SIGKILL'));
    this.readSession = opts.readSession ?? ((dir, pid) => JSON.parse(readFileSync(join(dir, 'sessions', `${pid}.json`), 'utf8')));
    this.createScreen = opts.createScreen ?? (() => rawScreen());
    this.isAlive = opts.isAlive ?? pidAlive;
    this.signal = opts.signal ?? ((pid, signal) => void process.kill(pid, signal));
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  status(): PtyStatus {
    return this.opts.spawn ? { enabled: true } : { enabled: false, reason: this.opts.disabledReason ?? tr('unavailable') };
  }

  list(): PtyInfo[] {
    const now = this.now();
    for (const [id, t] of this.ptys) {
      if (t.info.exitedAt !== undefined && now - t.info.exitedAt > EXITED_KEEP_MS) this.drop(id);
    }
    return [...this.ptys.values()].map((t) => ({ ...t.info }));
  }

  /** Opens a new Claude Code session in directory (absolute `cwd`), in requested account (or default). */
  create(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }): PtyInfo {
    return this.spawn(this.plan(p, this.takeovers.size));
  }

  /**
   * Opens the interactive agy of an Antigravity worker (Manual mode), or returns the one already open: `agy-as <acc>`
   * in the Antigravity room. "End" closes it like any terminal opened here (stop() finds it by agent).
   */
  openAgy(p: { agent: unknown; cols?: unknown; rows?: unknown }): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    const agy = this.opts.agy;
    const agentId = typeof p.agent === 'string' ? p.agent : '';
    const worker = agy?.worker(agentId);
    if (!agy || !worker) throw new PtyError(404, tr('Antigravity worker not found'));
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    if (!isExecutableFile(agy.bin)) throw new PtyError(503, tr("agy-as doesn't run: {0}", [agy.bin]));
    this.checkLimit(this.takeovers.size);
    const cols = clampInt(p.cols, 20, 400, 100);
    const rows = clampInt(p.rows, 5, 200, 30);
    const env = this.baseEnv();
    env.PATH = `${dirname(agy.bin)}:${env.PATH ?? ''}`;
    let proc: PtyProcess;
    try {
      proc = spawn(agy.bin, [worker.acc], { cwd: agy.cwd, cols, rows, env });
    } catch (err) {
      throw new PtyError(500, tr("couldn't open agy: {0}", [errMsg(err)]));
    }
    const info: PtyInfo = { id: `p${++this.seq}-${proc.pid}`, pid: proc.pid, cwd: agy.cwd, account: worker.account, agentId, startedAt: this.now() };
    log.info(tr('Terminal {0} opened in {1} (account {2}).', [info.id, agy.cwd, worker.acc]));
    return this.track(proc, info, cols, rows);
  }

  /**
   * Opens a sign-in terminal for an account (the accounts dialog): `file args` with `env` added, in `cwd`. It is no
   * agent: its agent id is "login:<account>", and asking again while one runs for the account returns that one.
   * `onExit` runs when it closes (the account is read again).
   */
  openLogin(p: { account: string; file: string; args: string[]; cwd: string; env?: Record<string, string>; cols?: unknown; rows?: unknown; onExit?: () => void }): PtyInfo {
    const agentId = `${LOGIN_PREFIX}${p.account}`;
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    const info = this.openProgram({ ...p, agentId });
    log.info(tr('Sign-in terminal {0} opened (account {1}).', [info.id, p.account]));
    return info;
  }

  /**
   * Opens a program in a terminal tied to `agentId` (worker sessions and the Antigravity boss, server/workers): the
   * browser shows it as that agent's terminal. `onData` sees the output (e.g. to notice someone typing); `onExit` runs
   * once it ends.
   */
  openProgram(p: {
    agentId: string;
    account: string;
    file: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    cols?: unknown;
    rows?: unknown;
    onExit?: (code: number) => void;
  }): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    if (!isExecutableFile(p.file)) throw new PtyError(503, tr("{0} doesn't run", [p.file]));
    this.checkLimit(this.takeovers.size);
    const cols = clampInt(p.cols, 20, 400, 120);
    const rows = clampInt(p.rows, 5, 200, 32);
    const env = { ...this.baseEnv(), ...p.env };
    env.PATH = `${dirname(p.file)}:${env.PATH ?? ''}`;
    let proc: PtyProcess;
    try {
      proc = spawn(p.file, p.args, { cwd: p.cwd, cols, rows, env });
    } catch (err) {
      throw new PtyError(500, tr("couldn't open {0}: {1}", [p.file, errMsg(err)]));
    }
    const info: PtyInfo = { id: `p${++this.seq}-${proc.pid}`, pid: proc.pid, cwd: p.cwd, account: p.account, agentId: p.agentId, startedAt: this.now() };
    const tracked = this.track(proc, info, cols, rows);
    if (p.onExit) proc.onExit(({ exitCode }) => p.onExit!(exitCode));
    return tracked;
  }

  /** The running terminal tied to this agent, if any. */
  ofAgent(agentId: string): PtyInfo | undefined {
    const t = this.byAgent(agentId);
    return t && { ...t.info };
  }

  /** Types into the running terminal of this agent (e.g. Esc to interrupt a turn); false when there is none. */
  typeTo(agentId: string, data: string): boolean {
    const t = this.byAgent(agentId);
    if (!t) return false;
    t.proc.write(data);
    return true;
  }

  /** Closes the running terminal of this agent (if any). */
  closeAgent(agentId: string): void {
    const t = this.byAgent(agentId);
    if (t) this.kill(t);
  }

  /**
   * Terminates a main agent. Opened here: closes pty. Opened in another terminal: terminates the process, but only
   * if account session registry confirms that PID is that Claude Code session (and running process with that PID
   * started when registry says and is Claude Code).
   */
  async stop(agentId: string): Promise<void> {
    const own = this.byAgent(agentId);
    if (own) {
      this.kill(own);
      return;
    }
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr("couldn't end the session: {0}", [errMsg(err)]));
    }
    log.info(tr('Agent {0} ended from the office.', [agentId]));
  }

  /**
   * Takes over a session open in another terminal: terminates external process, waits for it to exit, and continues
   * the conversation here (`claude --resume <session>`, in original directory and account). Blockers for the new
   * session (directory, account, limit) are checked before terminating external process; repeated requests wait
   * for the first.
   */
  takeover(agentId: string, size: { cols?: unknown; rows?: unknown } = {}): Promise<PtyInfo> {
    const own = this.opts.reopen?.(agentId);
    if (own) return Promise.resolve(own);
    const pending = this.takeovers.get(agentId);
    if (pending) return pending;
    const run = this.doTakeover(agentId, size).finally(() => this.takeovers.delete(agentId));
    this.takeovers.set(agentId, run);
    return run;
  }

  private async doTakeover(agentId: string, size: { cols?: unknown; rows?: unknown }): Promise<PtyInfo> {
    // Next tick: request is already in this.takeovers (counts towards limit below as "this" takeover).
    await Promise.resolve();
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    const agent = this.mainAgent(agentId);
    if (!SESSION_ID.test(agent.sessionId)) throw new PtyError(409, tr('session has no valid id to resume'));
    if (!agent.cwd) throw new PtyError(409, tr("I don't know this session's folder"));
    // Other takeovers in progress already have a reserved slot.
    const plan = this.plan({ cwd: agent.cwd, account: agent.account, cols: size.cols, rows: size.rows }, this.takeovers.size - 1);
    const ext = await this.external(agentId);
    try {
      await this.killPid(ext.pid, ext.proc);
    } catch (err) {
      throw new PtyError(500, tr("couldn't end the session in the other terminal: {0}", [errMsg(err)]));
    }
    if (!(await this.waitExit(ext.pid, TAKEOVER_WAIT_MS))) {
      // Did not exit in time: force-kill (if still same process) and wait a bit longer.
      log.warn(tr("Agent {0} didn't exit within {1} s: forcing it to close.", [agentId, TAKEOVER_WAIT_MS / 1000]));
      try {
        if (await this.stillSame(ext.pid, ext.proc)) this.forceKill(ext.pid);
      } catch (err) {
        log.warn(tr('Failed to force-kill process {0}: {1}', [ext.pid, errMsg(err)]));
      }
      if (!(await this.waitExit(ext.pid, FORCE_WAIT_MS))) {
        throw new PtyError(500, tr("the session in the other terminal didn't close, even when forced; it's still open there"));
      }
    }
    let info: PtyInfo;
    try {
      info = this.spawn(plan, { resume: agent.sessionId, from: agentId });
    } catch (err) {
      // External session was already terminated: explain how to continue conversation.
      throw new PtyError(500, tr("the session was ended in the other terminal, but didn't open here ({0}); to continue: claude --resume {1}", [errMsg(err), agent.sessionId]));
    }
    log.info(tr('Agent {0} taken over by the office (session {1}).', [agentId, agent.sessionId]));
    return info;
  }

  /** Connects an SSE client: current screen first, then live output. */
  attach(id: string, req: IncomingMessage, res: ServerResponse): void {
    const pty = this.get(id);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    // Output arriving while the screen finishes processing prior input is queued for this client.
    const queue: string[] = [];
    pty.pending.set(res, queue);
    const drop = () => {
      pty.pending.delete(res);
      pty.clients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    pty.screen.write('', () => {
      if (!pty.pending.delete(res) || res.writableEnded) return;
      res.write(frame('reset', pty.screen.serialize()));
      for (const data of queue) res.write(frame('data', data));
      if (pty.info.exitedAt !== undefined) res.write(frame('exit', { code: pty.info.exitCode ?? 0 }));
      pty.clients.add(res);
    });
  }

  input(id: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new PtyError(400, tr('invalid input'));
    const pty = this.running(id);
    pty.proc.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const pty = this.running(id);
    const c = clampInt(cols, 20, 400, 100);
    const r = clampInt(rows, 5, 200, 30);
    pty.proc.resize(c, r);
    pty.screen.resize(c, r);
  }

  /** Terminates process (if still running) or removes from list (if already exited). */
  close(id: string): void {
    const pty = this.get(id);
    if (pty.info.exitedAt === undefined) this.kill(pty);
    else {
      this.drop(id);
      this.opts.onChange();
    }
  }

  stopAll(): void {
    for (const t of this.ptys.values()) {
      for (const c of t.clients) c.end();
      for (const c of t.pending.keys()) c.end();
      t.screen.dispose();
      if (t.info.exitedAt === undefined) {
        try {
          t.proc.kill();
        } catch {
          // shutting down server: nothing to do
        }
      }
    }
    this.ptys.clear();
  }

  /** Validates new session request (`reserved`: slots already promised to takeovers in progress). */
  private plan(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }, reserved = 0): SpawnPlan {
    if (!this.opts.spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    // First of all (takeover terminates external session after this): non-working claude would open terminal that
    // exits immediately.
    if (!isExecutableFile(this.opts.claudeBin)) throw new PtyError(503, tr("the Claude Code executable doesn't run: {0} (check HABBLAUD_CLAUDE_BIN)", [this.opts.claudeBin]));
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new PtyError(400, tr('provide the project folder (absolute path)'));
    const cwd = resolve(p.cwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // handled below
    }
    if (!isDir) throw new PtyError(400, tr('folder not found: {0}', [cwd]));
    const accounts = this.opts.accounts();
    const account = typeof p.account === 'string' ? accounts.find((a) => a.id === p.account) : (accounts.find((a) => a.isDefault) ?? accounts[0]);
    if (!account) throw new PtyError(400, tr('unknown account'));
    this.checkLimit(reserved);
    return { cwd, account, cols: clampInt(p.cols, 20, 400, 100), rows: clampInt(p.rows, 5, 200, 30) };
  }

  private checkLimit(reserved: number): void {
    const running = [...this.ptys.values()].filter((t) => t.info.exitedAt === undefined).length;
    if (running + Math.max(0, reserved) >= MAX_PTYS) throw new PtyError(429, tr('limit of {0} open terminals', [MAX_PTYS]));
  }

  /** Server environment for a terminal, without the variables of the Claude Code session Habblaud may run inside. */
  private baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of INHERITED_SESSION_VARS) delete env[k];
    return env;
  }

  private spawn(plan: SpawnPlan, p: { resume?: string; from?: string } = {}): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, tr('terminal disabled: {0}', [this.opts.disabledReason ?? tr('unavailable')]));
    const { cwd, account, cols, rows } = plan;
    const env = this.baseEnv();
    if (account.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = account.dir;

    let proc: PtyProcess;
    try {
      const args = p.resume ? ['--resume', p.resume] : [];
      proc = spawn(this.opts.claudeBin, args, { cwd, cols, rows, env });
    } catch (err) {
      throw new PtyError(500, tr("couldn't open Claude Code: {0}", [errMsg(err)]));
    }
    const id = `p${++this.seq}-${proc.pid}`;
    const info: PtyInfo = { id, pid: proc.pid, cwd, account: account.id, agentId: `${account.id}:${proc.pid}`, startedAt: this.now() };
    if (p.resume) info.resumed = p.resume;
    if (p.from) info.fromAgent = p.from;
    log.info(p.resume ? tr('Terminal {0} opened in {1} (account {2}, resuming {3}).', [id, cwd, account.id, p.resume]) : tr('Terminal {0} opened in {1} (account {2}).', [id, cwd, account.id]));
    return this.track(proc, info, cols, rows);
  }

  /** Keeps a newly opened terminal: its screen, live output to clients, and the exit. */
  private track(proc: PtyProcess, info: PtyInfo, cols: number, rows: number): PtyInfo {
    const id = info.id;
    const pty: Pty = { info, proc, screen: this.createScreen(cols, rows), clients: new Set(), pending: new Map() };
    this.ptys.set(id, pty);
    proc.onData((data) => {
      pty.screen.write(data);
      for (const queue of pty.pending.values()) queue.push(data);
      this.broadcast(pty, 'data', data);
    });
    proc.onExit(({ exitCode }) => {
      pty.info.exitedAt = this.now();
      pty.info.exitCode = exitCode;
      this.broadcast(pty, 'exit', { code: exitCode });
      this.opts.onChange();
    });
    this.opts.onChange();
    return { ...info };
  }

  private byAgent(agentId: string): Pty | undefined {
    for (const t of this.ptys.values()) if (t.info.agentId === agentId && t.info.exitedAt === undefined) return t;
    return undefined;
  }

  private mainAgent(agentId: string): PtyAgentRef {
    const agent = this.opts.agent(agentId);
    if (!agent) throw new PtyError(404, tr('agent not found'));
    if (agent.kind !== 'main') throw new PtyError(400, tr("only a session's main agent can be ended or taken over"));
    return agent;
  }

  /**
   * Main agent opened outside Habblaud, verified by account session registry (same session) and by the
   * system (process with this PID started when registry says and is Claude Code).
   */
  private async external(agentId: string): Promise<ExternalProc> {
    const agent = this.mainAgent(agentId);
    const m = MAIN_ID.exec(agent.id);
    const pid = m ? Number(m[2]) : NaN;
    if (!m || m[1] !== agent.account || !Number.isSafeInteger(pid) || pid <= 0) throw new PtyError(400, tr('agent has no known process'));
    const account = this.opts.accounts().find((a) => a.id === agent.account);
    if (!account) throw new PtyError(400, tr('unknown account'));
    let registered: unknown;
    try {
      registered = this.readSession(account.dir, pid);
    } catch {
      throw new PtyError(409, tr('the session is no longer open'));
    }
    const r = (registered ?? {}) as { sessionId?: unknown; startedAt?: unknown; procStart?: unknown };
    if (r.sessionId !== agent.sessionId) throw new PtyError(409, tr('the process no longer belongs to this session'));
    if (!this.isAlive(pid)) throw new PtyError(409, tr('the session is no longer open'));
    const reg: RegisteredProc = {
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : undefined,
      procStart: typeof r.procStart === 'string' ? r.procStart : undefined,
    };
    const proc = await this.procInfo(pid);
    if (!proc) throw new PtyError(409, tr("couldn't check this session's process (it may have already ended)"));
    if (!sameProcess(reg, proc)) throw new PtyError(409, tr('process {0} is no longer this Claude Code session (stale record?)', [pid]));
    return { pid, proc };
  }

  /** Is process `pid` still the same as `proc` (alive, same executable and same start time)? */
  private async stillSame(pid: number, proc: ProcInfo): Promise<boolean> {
    if (!this.isAlive(pid)) return false;
    const now = await this.procInfo(pid);
    if (!now || now.name !== proc.name) return false;
    return proc.fileTime && now.fileTime ? now.fileTime === proc.fileTime : Math.abs(now.startMs - proc.startMs) < 1_000;
  }

  /** Waits for `pid` to exit (true) or timeout (false). */
  private async waitExit(pid: number, ms: number): Promise<boolean> {
    for (let waited = 0; this.isAlive(pid) && waited < ms; waited += 100) await this.sleep(100);
    return !this.isAlive(pid);
  }

  /**
   * Closes a terminal: SIGHUP (node-pty). A program that catches it and stays (agy at its prompts) gets SIGTERM after
   * KILL_TERM_MS and SIGKILL after FORCE_WAIT_MS more.
   */
  private kill(pty: Pty): void {
    try {
      pty.proc.kill();
    } catch (err) {
      log.warn(tr('Failed to close terminal {0}: {1}', [pty.info.id, errMsg(err)]));
    }
    const later = (ms: number, signal: NodeJS.Signals) =>
      setTimeout(() => {
        if (pty.info.exitedAt !== undefined) return;
        try {
          this.signal(pty.info.pid, signal);
        } catch {
          // already gone
        }
      }, ms).unref?.();
    later(KILL_TERM_MS, 'SIGTERM');
    later(KILL_TERM_MS + FORCE_WAIT_MS, 'SIGKILL');
  }

  private get(id: string): Pty {
    const pty = this.ptys.get(id);
    if (!pty) throw new PtyError(404, tr('terminal not found'));
    return pty;
  }

  private running(id: string): Pty {
    const pty = this.get(id);
    if (pty.info.exitedAt !== undefined) throw new PtyError(409, tr('the terminal has already been closed'));
    return pty;
  }

  private drop(id: string): void {
    const t = this.ptys.get(id);
    if (!t) return;
    for (const c of t.clients) c.end();
    for (const c of t.pending.keys()) c.end();
    t.screen.dispose();
    this.ptys.delete(id);
  }

  private broadcast(pty: Pty, event: string, data: unknown): void {
    const f = frame(event, data);
    for (const c of pty.clients) c.write(f);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Loads node-pty (optional dependency) and verifies it opens a terminal. Returns null + reason if unavailable:
 * without this, takeover would terminate external session and only then discover it cannot open here.
 */
export async function loadPty(): Promise<{ spawn: SpawnPty | null; reason?: string }> {
  let ptySpawn: ((file: string, args: string[], o: Record<string, unknown>) => PtyProcess) | undefined;
  try {
    const mod = (await import('node-pty')) as unknown as {
      spawn?: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess;
      default?: { spawn: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess };
    };
    ptySpawn = mod.spawn ?? mod.default?.spawn;
  } catch (err) {
    return { spawn: null, reason: tr('node-pty not installed ({0})', [errMsg(err)]) };
  }
  if (!ptySpawn) return { spawn: null, reason: tr('node-pty has no spawn()') };
  const nativeSpawn = ptySpawn;
  const spawn: SpawnPty = (file, args, o) => nativeSpawn(file, args, { name: 'xterm-256color', cwd: o.cwd, cols: o.cols, rows: o.rows, env: o.env });
  // On Windows there is no spawn-helper; spawn test is meant for macOS and Linux.
  if (process.platform === 'win32') return { spawn };
  const dir = nodePtyDir();
  if (dir) fixSpawnHelper(dir);
  const problem = await spawnProblem(spawn);
  return problem ? { spawn: null, reason: problem } : { spawn };
}

/** node-pty package directory (undefined if not found). */
function nodePtyDir(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return undefined;
  }
}

/**
 * node-pty 1.1.0 publishes macOS `spawn-helper` (prebuilds/darwin-*) without execute permission, and no install script
 * restores it: without it, every terminal fails with "posix_spawnp failed". Restores execution permission in dirs
 * where node-pty searches for native binary (spawn-helper used is the one next to it).
 */
export function fixSpawnHelper(ptyDir: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): void {
  for (const sub of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    const file = join(ptyDir, sub, 'spawn-helper');
    try {
      const mode = statSync(file).mode;
      if (!(mode & 0o100)) chmodSync(file, (mode & 0o777) | 0o111);
    } catch {
      // does not exist (or could not chmod): spawn test will report whether terminal opens
    }
  }
}

/** Opens a test terminal (Node itself, which exits immediately): null if succeeded, otherwise the reason. */
export function spawnProblem(spawn: SpawnPty, timeoutMs = 5_000): Promise<string | null> {
  let proc: PtyProcess;
  try {
    proc = spawn(process.execPath, ['-e', ''], { cwd: process.cwd(), cols: 80, rows: 24, env: process.env });
  } catch (err) {
    return Promise.resolve(tr("node-pty can't open terminals ({0})", [errMsg(err)]));
  }
  return new Promise((ok) => {
    // Opened and did not exit in time: spawn works, which is what matters here.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      ok(null);
    }, timeoutMs);
    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      ok(exitCode === 0 ? null : tr('node-pty opened the test terminal, but it exited with code {0}', [exitCode]));
    });
  });
}
