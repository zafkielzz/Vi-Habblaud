// Messages from the office to Codex sessions: `codex queue --thread <threadId> --message <text>` places the
// message into the thread queue (it enters when the session becomes idle; the thread owner polls the queue every ~10 s;
// the turn it opens brings turn_trigger "queue"). The command must run on the host (Mac/PC), with the account's CODEX_HOME:
// - Node mode: the server itself runs the command (HABBLAUD_CODEX_BIN binary or `codex` in PATH);
// - Docker: the host helper (scripts/codex-bridge.ts, npm run codex:bridge) fetches messages via
//   POST /api/codex/bridge/poll, runs the same command, and confirms via POST /api/codex/bridge/ack.
// Shell-free (execFile), with timeout, and never with -c, --enable, --disable, or --no-daemon (they would alter the
// configuration or the session daemon). Exit code 0 ("Queued message <id> for thread <thread>.") = queued — even if
// nobody currently has the thread open; other exit code = failed, and the 1st line of stderr explains why ("Error: ... no
// rollout found for thread id ..."). If the shared Codex server (daemon) is not running, the command itself starts it.
// Pure Node with no dependencies: also imported by the host helper (via tsx).
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { tr } from '../../shared/i18n';

/** Timeout for `codex queue`. */
export const QUEUE_TIMEOUT_MS = 20_000;
/** Codex thread id (UUID; `codex queue --thread` also accepts names, but Habblaud only sends ids). */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_MAX = 300;

export interface CodexQueueJob {
  /** Account CODEX_HOME folder (host path). */
  codexHome: string;
  /** Thread id (Codex agent AgentInfo.sessionId). */
  thread: string;
  /** The text as typed. */
  text: string;
}

export type CodexQueueResult = { ok: true } | { ok: false; error: string };
export type CodexQueueRunner = (job: CodexQueueJob) => Promise<CodexQueueResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Binary name in PATH. On Windows, only `codex.exe`: `codex` without extension and `codex.cmd` created by npm
 * are scripts, and execFile (without shell) cannot run them.
 */
export const CODEX_BIN_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';

/** Codex binary: HABBLAUD_CODEX_BIN (executable path) or `codex` in PATH. undefined = not found. */
export function findCodexBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_CODEX_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, CODEX_BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Arguments for `codex queue` (using "=": text starting with "-" is never treated as an option). */
export function queueArgs(thread: string, text: string): string[] {
  return ['queue', `--thread=${thread}`, `--message=${text}`];
}

/** First non-empty line (Codex prints errors as "Error: ..."), trimmed. */
export function firstLine(s: string | undefined): string | undefined {
  const line = (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** Runs `codex queue` with the given binary. Never rejects: failure becomes `{ok: false, error}`. */
export function createCodexQueueRunner(bin: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CodexQueueRunner {
  const timeoutMs = opts.timeoutMs ?? QUEUE_TIMEOUT_MS;
  return (job) =>
    new Promise<CodexQueueResult>((done) => {
      if (!THREAD_ID.test(job.thread)) return done({ ok: false, error: tr('invalid Codex thread id') });
      if (!isAbsolute(job.codexHome)) return done({ ok: false, error: tr('invalid Codex account folder') });
      const env = { ...(opts.env ?? process.env), CODEX_HOME: job.codexHome };
      try {
        execFile(bin, queueArgs(job.thread, job.text), { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (err, _stdout, stderr) => {
          if (!err) return done({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) return done({ ok: false, error: tr("codex queue didn't respond within {0} s (the message may have been queued anyway)", [Math.round(timeoutMs / 1_000)]) });
          if (e.code === 'ENOENT' || e.code === 'EACCES') return done({ ok: false, error: tr("couldn't run Codex ({0})", [bin]) });
          done({ ok: false, error: firstLine(stderr) ?? tr('codex queue failed (code {0})', [String(e.code ?? '?')]) });
        });
      } catch {
        // Argument that cannot be passed to a process (e.g. NUL character in text).
        done({ ok: false, error: tr("the message has characters that can't be sent to Codex") });
      }
    });
}
