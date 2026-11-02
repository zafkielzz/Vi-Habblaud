// Installs (or removes) the Habblaud statusline tap in each Claude Code account. Runs on the HOST, with tsx:
//
//   npm run usage:install     # wraps each account's statusLine.command with the tap (backs up first)
//   npm run usage:uninstall   # restores the original command
//   npm run usage:status      # shows, per account, whether installed and age of last captured usage
//   (options: --dry-run shows what would change without writing anything; --node <path> selects node)
//
// The tap (scripts/statusline-tap.mjs) receives from Claude Code the same JSON that the statusline already receives
// and keeps only 5h/weekly usage percentages in ~/.habblaud/usage/<account>.json, passing everything
// to the original statusline. This way Habblaud shows live usage without reading credentials.
//
// In <account>/settings.json only statusLine.command changes (other fields and keys remain as
// they are); before writing, a copy goes to settings.json.habblaud-backup-<date>.
//
// Legacy name (CodeTown, up to 0.3.2): install moves ~/.codetown to ~/.habblaud before anything else, so that
// already captured usage remains valid.
import { accessSync, chmodSync, constants, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { describeStateMigration, LEGACY_NAME, migrateLegacyStateDir } from '../server/legacy';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TAP_SCRIPT = join(ROOT, 'scripts', 'statusline-tap.mjs');
const TAP_NAME = 'statusline-tap.mjs';

const USAGE = tr(`Usage: npm run usage:<install|uninstall|status> [-- options]

  install     wraps each account's statusline with the Habblaud tap (backs up settings.json)
  uninstall   restores each account's original statusline
  status      shows whether the tap is installed and when each account's last usage arrived

Options:
  --dry-run        shows what would change, without writing anything
  --node <cmd>     node command used in the statusline (default: detected in PATH)
  -h, --help       shows this help

Accounts: the same as the server's (~/.claude* with projects/ or sessions/, CLAUDE_CONFIG_DIR or
HABBLAUD_CLAUDE_DIRS). Usage captured in HABBLAUD_USAGE_DIR (default ~/.habblaud/usage).`);

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/statusline-install.test.ts)
// ---------------------------------------------------------------------------------------------

/** Characters that do not require quotes in a shell command. */
const SAFE_WORD = /^[\w@%+=:,./~-]+$/;

/** Shell single quotes (the only special character inside is the single quote itself). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Inverts shellQuote; returns undefined if `s` is not strictly a single-quoted word. */
export function shellUnquote(s: string): string | undefined {
  const m = /^'((?:[^']|'\\'')*)'$/.exec(s);
  return m ? m[1].replace(/'\\''/g, "'") : undefined;
}

/**
 * The original command as an argument of the tap. Simple commands (only "safe" words, like
 * `npx -y ccstatusline`) stay readable without quotes; the rest is fully single-quoted so that
 * pipes, `&&`, quotes, and redirections apply only to the original command.
 */
export function encodeOriginal(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  return words.every((w) => SAFE_WORD.test(w)) ? words.join(' ') : shellQuote(cmd.trim());
}

export function decodeOriginal(arg: string): string {
  const t = arg.trim();
  return shellUnquote(t) ?? t;
}

export function isTapCommand(cmd: unknown): cmd is string {
  return typeof cmd === 'string' && cmd.includes(TAP_NAME);
}

/** Double-quoted path (readable); with `$`, backtick, `"` or `\\`, single quotes. */
export function quotePath(p: string): string {
  return /^[^"$`\\]*$/.test(p) ? `"${p}"` : shellQuote(p);
}

function unquotePath(q: string): string {
  if (q.startsWith('"')) return q.slice(1, -1);
  return shellUnquote(q) ?? q;
}

/** `node "<tap>" -- <original>` (or just `node "<tap>"` when there was no statusline). */
export function wrapCommand(nodeCmd: string, tapPath: string, original?: string): string {
  const node = SAFE_WORD.test(nodeCmd) ? nodeCmd : quotePath(nodeCmd);
  const head = `${node} ${quotePath(tapPath)}`;
  return original?.trim() ? `${head} -- ${encodeOriginal(original)}` : head;
}

const WRAPPED =
  /^\s*(?:"[^"]*"|'(?:[^']|'\\'')*'|\S+)\s+("[^"]*statusline-tap\.mjs"|'(?:[^']|'\\'')*statusline-tap\.mjs'|\S*statusline-tap\.mjs)(?:\s+--(?:\s+([\s\S]*))?)?\s*$/;

/** Original command stored in an already wrapped command ('' = there was no statusline). */
export function unwrapCommand(cmd: string): { tapPath: string; original: string } | undefined {
  const m = WRAPPED.exec(cmd);
  if (!m) return undefined;
  return { tapPath: unquotePath(m[1]), original: m[2] ? decodeOriginal(m[2]) : '' };
}

export type Settings = Record<string, unknown>;
export type StatusLine = Record<string, unknown> & { type?: unknown; command?: unknown };

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

function statusLineOf(settings: Settings): StatusLine | undefined {
  const sl = settings.statusLine;
  return sl && typeof sl === 'object' && !Array.isArray(sl) ? (sl as StatusLine) : undefined;
}

/** Install plan for an already read settings.json (writes nothing). */
export function planInstall(settings: Settings, nodeCmd: string, tapPath: string): PlanAction {
  const sl = statusLineOf(settings);
  if (settings.statusLine !== undefined && !sl) return { action: 'skip', message: tr('statusLine in an unknown format; nothing was changed') };
  if (!sl) {
    return {
      action: 'install',
      settings: { ...settings, statusLine: { type: 'command', command: wrapCommand(nodeCmd, tapPath) } },
      message: tr('no statusline before: created one that only captures usage (prints nothing)'),
    };
  }
  if (sl.type !== undefined && sl.type !== 'command') return { action: 'skip', message: tr('statusLine of type "{0}" isn\'t supported; nothing was changed', [String(sl.type)]) };
  if (typeof sl.command !== 'string' || !sl.command.trim()) return { action: 'skip', message: tr('statusLine without a command; nothing was changed') };
  if (isTapCommand(sl.command)) {
    const cur = unwrapCommand(sl.command);
    if (!cur) return { action: 'skip', message: tr('the command already mentions the tap, but not in the expected format; check it by hand') };
    const next = wrapCommand(nodeCmd, tapPath, cur.original);
    if (next === sl.command) return { action: 'none', message: tr('already installed') };
    return { action: 'install', settings: { ...settings, statusLine: { ...sl, command: next } }, message: tr('updated (new Habblaud or node path)') };
  }
  return {
    action: 'install',
    settings: { ...settings, statusLine: { ...sl, command: wrapCommand(nodeCmd, tapPath, sl.command) } },
    message: tr('installed in front of: {0}', [sl.command]),
  };
}

/** Removal plan: restores original command (or removes the statusLine created by the tap itself). */
export function planUninstall(settings: Settings): PlanAction {
  const sl = statusLineOf(settings);
  if (!sl || !isTapCommand(sl.command)) return { action: 'none', message: tr("wasn't installed") };
  const cur = unwrapCommand(sl.command);
  if (!cur) return { action: 'skip', message: tr('the command mentions the tap, but not in the expected format; check it by hand') };
  if (!cur.original) {
    const rest = { ...settings };
    delete rest.statusLine;
    return { action: 'uninstall', settings: rest, message: tr('statusline created by Habblaud removed') };
  }
  return { action: 'uninstall', settings: { ...settings, statusLine: { ...sl, command: cur.original } }, message: `restaurado: ${cur.original}` };
}

/** Directories where a `node` outside version managers remains stable across updates. */
function stableNode(p: string, home: string): boolean {
  const dir = dirname(p);
  const stable = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), join(home, '.local', 'share', 'mise', 'shims')];
  return stable.includes(dir);
}

/**
 * Node command for the statusline: absolute path when PATH's `node` is in a stable location
 * (Homebrew, /usr/local...); otherwise just `node` — nvm/fnm paths change with each version, and the
 * original statusline (npx...) already relies on PATH's node anyway.
 */
export function detectNodeCommand(env: NodeJS.ProcessEnv, home: string, isExecutable: (p: string) => boolean = canExecute): string {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'node');
    if (!isExecutable(p)) continue;
    return stableNode(p, home) ? p : 'node';
  }
  return 'node';
}

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return tr('{0} days', [Math.round(h / 24)]);
}

// ---------------------------------------------------------------------------------------------
// Effects (files)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  nodeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  tapPath: string;
  out: (line: string) => void;
}

class FatalError extends Error {}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let nodeCmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--node') {
      nodeCmd = argv[++i];
      if (!nodeCmd) throw new FatalError(tr('--node needs a path.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('specify what to do: install, uninstall or status.\n\n{0}', [USAGE]));
  return { command, dryRun, nodeCmd };
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `~/...` for what is in HOME; on Windows also with `\` (the rest outputs with `/`, as Git Bash writes). */
export function tildify(p: string, home: string): string {
  if (p !== home && !p.startsWith(`${home}/`) && !p.startsWith(`${home}${sep}`)) return p;
  return `~${p.slice(home.length).split(sep).join('/')}`;
}

export function readSettings(file: string): { settings: Settings; raw?: string } | { error: string } {
  if (!existsSync(file)) return { settings: {} };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: tr("couldn't read ({0})", [(err as Error).message]) };
  }
  if (!raw.trim()) return { settings: {}, raw };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: tr('not a JSON object; nothing was changed') };
    return { settings: parsed as Settings, raw };
  } catch {
    return { error: tr('invalid JSON; nothing was changed') };
  }
}

/** Backup + atomic write preserving file permissions. Returns backup path. */
export function writeSettings(file: string, settings: Settings, raw: string | undefined, now: Date): string | undefined {
  let mode = 0o600;
  if (raw !== undefined) mode = statSync(file).mode & 0o777;
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  // Re-read now: the backup is what rename replaces. If changed since reading, abort (no merge).
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      unlinkSync(tmp);
      throw err;
    }
  }
  if (current !== raw) {
    unlinkSync(tmp);
    throw new Error(tr('the file changed since it was read; nothing was changed, run the command again'));
  }
  let backup: string | undefined;
  if (current !== undefined) {
    backup = `${file}.habblaud-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.habblaud-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, current, { mode: 0o600 });
  }
  renameSync(tmp, file);
  return backup;
}

/** Captured usage directory (HABBLAUD_USAGE_DIR or ~/.habblaud/usage); also used by mod-install. */
export function usageDirOf(env: NodeJS.ProcessEnv, home: string): string {
  const d = env.HABBLAUD_USAGE_DIR?.trim();
  return d ? resolve(d.replace(/^~(?=\/|$)/, home)) : join(home, '.habblaud', 'usage');
}

/**
 * Migrates ~/.codetown (legacy name) to ~/.habblaud before creating or using the usage folder; also used by
 * mod-install. Applies even if HABBLAUD_USAGE_DIR is elsewhere (names and stats also live there, outside
 * Docker). Returns the output line (undefined = nothing to do); in dry-run, only describes what it would do.
 */
export function migrateLegacyState(home: string, dryRun: boolean): string | undefined {
  if (dryRun) {
    let legacy = false;
    try {
      legacy = statSync(join(home, `.${LEGACY_NAME}`)).isDirectory();
    } catch {
      legacy = false;
    }
    return legacy ? tr('~ ~/.{0} (old name) goes to ~/.habblaud (dry run: nothing moved)', [LEGACY_NAME]) : undefined;
  }
  const r = migrateLegacyStateDir(home);
  const msg = describeStateMigration(r);
  return msg && `${r.error ? '!' : '✓'} ${msg}`;
}

/** Age of the last captured usage of an account (tap file), or undefined. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string): { at: number; five?: number; week?: number } | undefined {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { utilization?: unknown } | unknown>;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    const pct = (w: unknown) => (w && typeof w === 'object' && typeof (w as { utilization?: unknown }).utilization === 'number' ? ((w as { utilization: number }).utilization) : undefined);
    return { at, five: pct(j.five_hour), week: pct(j.seven_day) };
  } catch {
    return undefined;
  }
}

/** Runs the command for all accounts. Returns exit code. */
export function run(opts: RunOptions, ctx: RunContext): number {
  const { env, home, out } = ctx;
  const dirs = discoverClaudeDirs(env, home);
  if (!dirs.length) {
    out(tr("No Claude Code account found (~/.claude* with projects/ or sessions/). Use HABBLAUD_CLAUDE_DIRS if they're somewhere else."));
    return 1;
  }
  const nodeCmd = opts.nodeCmd ?? detectNodeCommand(env, home);
  // Legacy name: tap now writes to ~/.habblaud/usage; what was in ~/.codetown moves along.
  if (opts.command === 'install') {
    const moved = migrateLegacyState(home, opts.dryRun);
    if (moved) out(moved);
  }
  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const file = join(dir, 'settings.json');
    const label = `${basename(dir)} (${tildify(file, home)})`;
    const read = readSettings(file);
    if ('error' in read) {
      out(`✗ ${label}: ${read.error}`);
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const sl = statusLineOf(read.settings);
      const wrapped = sl && isTapCommand(sl.command) ? unwrapCommand(sl.command) : undefined;
      const state = wrapped
        ? tr('installed{0}', [wrapped.original ? tr(' (in front of: {0})', [wrapped.original]) : tr(' (no original statusline)')])
        : sl && typeof sl.command === 'string'
          ? tr('not installed (current statusline: {0})', [sl.command])
          : tr('not installed (no statusline)');
      if (wrapped?.tapPath && resolve(wrapped.tapPath) !== resolve(ctx.tapPath)) out(tr('! {0}: the tap points to {1}; run npm run usage:install to update', [label, wrapped.tapPath]));
      const cap = lastCapture(dir, env, home);
      const capText = cap
        ? tr('last usage captured {0} ago{1}{2}', [formatAge(ctx.now.getTime() - cap.at), cap.five !== undefined ? ` · 5h ${Math.round(cap.five)}%` : '', cap.week !== undefined ? tr(' · week {0}%', [Math.round(cap.week)]) : ''])
        : wrapped
          ? tr('no usage captured yet (Claude Code sends the limits after the first reply in an open session)')
          : tr('no usage captured');
      out(`• ${label}: ${state}; ${capText}`);
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, nodeCmd, ctx.tapPath) : planUninstall(read.settings);
    if (plan.action === 'none') {
      out(`= ${label}: ${plan.message}`);
      continue;
    }
    if (plan.action === 'skip') {
      out(`✗ ${label}: ${plan.message}`);
      failures++;
      continue;
    }
    if (opts.dryRun) {
      out(tr('~ {0}: {1} (dry run: nothing written)', [label, plan.message]));
      out(`    statusLine → ${JSON.stringify(plan.settings.statusLine ?? null)}`);
      continue;
    }
    try {
      const backup = writeSettings(file, plan.settings, read.raw, ctx.now);
      out(`✓ ${label}: ${plan.message}${backup ? tr(' · backup in {0}', [tildify(backup, home)]) : ''}`);
      changed++;
    } catch (err) {
      out(tr("✗ {0}: couldn't write ({1})", [label, (err as Error).message]));
      failures++;
    }
  }
  if (opts.command === 'install' && changed) {
    out('');
    out(tr("Done. The numbers show up in Habblaud after each session's next reply. Sessions that are already"));
    out(tr("open usually reload settings.json on their own; if usage doesn't show up, reopen the session."));
    out(tr('Usage captured in {0}. To undo: npm run usage:uninstall', [tildify(usageDirOf(env, home), home)]));
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = run(parsed, { env: process.env, home, now: new Date(), tapPath: TAP_SCRIPT, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[usage] Error: {0}', [err.message]) : tr('[usage] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
