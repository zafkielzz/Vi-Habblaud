// Installs (or removes) Habblaud permission hook in each Claude Code account. Runs on HOST, with tsx:
//
//   npm run hooks:install     # adds PermissionRequest hook to <account>/settings.json (backs up first)
//   npm run hooks:uninstall   # removes only Habblaud hook (your hooks stay)
//   npm run hooks:status      # shows, per account, if installed and whether Habblaud answers requests
//   (options: --dry-run, --node <path>, --port <n>, --timeout <s>)
//
// In Claude Code 2.1.287+ the same hook comes bundled in `habblaud-permissoes` plugin from repository
// marketplace (mod/habblaud-permissoes, running the SAME script); this installer remains for older
// versions and removing legacy installs.
//
// The hook (mod/habblaud-permissoes/hooks/permission-hook.mjs) allows approving or denying permission
// requests ("Do you want to…") from the office: Claude Code keeps showing terminal prompt and whichever
// answer arrives first wins. If Habblaud is down or no page is open, hook exits immediately and nothing changes.
//
// In <account>/settings.json only hooks.PermissionRequest list changes: a group {matcher: "*", hooks:
// [{type: "command", command: 'node "<Habblaud>/mod/habblaud-permissoes/hooks/permission-hook.mjs"', timeout,
// statusMessage}]} is added (other hooks and keys stay untouched). Before writing, a backup is saved to
// settings.json.habblaud-backup-<date>. Re-running updates path/options without duplicating (and replaces
// legacy path, scripts/permission-hook.mjs, from before 0.3, and old name, mod/codetown-permissoes/).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { detectNodeCommand, quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-permissoes', 'hooks', 'permission-hook.mjs');
/** Where the script lived up to 0.2 (legacy installs point here; status warns and advises reinstall). */
export const LEGACY_HOOK_SCRIPT = join(ROOT, 'scripts', 'permission-hook.mjs');
/**
 * Hook is recognized by filename in any folder: legacy path (scripts/), old name
 * (mod/codetown-permissoes/hooks/, gone) and new path (mod/habblaud-permissoes/hooks/) count
 * as "ours", and install/uninstall replace or remove any of them.
 */
const HOOK_NAME = 'permission-hook.mjs';
const EVENT = 'PermissionRequest';
export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
/** Claude Code timeout slack over hook timeout (hook always gives up earlier). */
const TIMEOUT_SLACK_S = 30;
export const STATUS_MESSAGE = tr('Waiting for an answer in Habblaud');

const USAGE = tr("Usage: npm run hooks:<install|uninstall|status> [-- options]\n\n  install     adds the Habblaud permission hook to each account (backs up settings.json)\n  uninstall   removes the Habblaud hook from each account (other hooks stay)\n  status      shows whether the hook is installed and whether Habblaud is handling requests\n\nOptions:\n  --dry-run        shows what would change, without writing anything\n  --node <cmd>     node command used in the hook (default: detected in PATH)\n  --port <n>       Habblaud port (default: HABBLAUD_PORT or {0})\n  --timeout <s>    how long the hook waits for your answer in Habblaud before handing the request back to the terminal\n                   (default: {1} s)\n  -h, --help       shows this help\n\nAccounts: the same as the server's (~/.claude* with projects/ or sessions/, CLAUDE_CONFIG_DIR or\nHABBLAUD_CLAUDE_DIRS).", [DEFAULT_PORT, DEFAULT_TIMEOUT_S]);

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/hooks-install.test.ts)
// ---------------------------------------------------------------------------------------------

export interface HookOptions {
  port: number;
  timeoutS: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** `node "<hook>"`, with --port/--timeout only when different from default. */
export function hookCommand(nodeCmd: string, scriptPath: string, o: HookOptions): string {
  const node = /^[\w@%+=:,./~-]+$/.test(nodeCmd) ? nodeCmd : quotePath(nodeCmd);
  let cmd = `${node} ${quotePath(scriptPath)}`;
  if (o.port !== DEFAULT_PORT) cmd += ` --port ${o.port}`;
  if (o.timeoutS !== DEFAULT_TIMEOUT_S) cmd += ` --timeout ${o.timeoutS}`;
  return cmd;
}

/** Hook as read by Claude Code in hooks.PermissionRequest[].hooks[]. */
export function hookEntry(command: string, o: HookOptions): Rec {
  return { type: 'command', command, timeout: o.timeoutS + TIMEOUT_SLACK_S, statusMessage: STATUS_MESSAGE };
}

export function isOurHook(h: unknown): boolean {
  const r = rec(h);
  return !!r && typeof r.command === 'string' && r.command.includes(HOOK_NAME);
}

export type PlanAction =
  | { action: 'install'; settings: Settings; message: string }
  | { action: 'uninstall'; settings: Settings; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** hooks and hooks.PermissionRequest in editable format (or reason not to touch). */
function eventList(settings: Settings): { hooks: Rec; list: unknown[] } | string {
  if (settings.hooks !== undefined && !rec(settings.hooks)) return tr('"hooks" in an unknown format; nothing was changed');
  const hooks = rec(settings.hooks) ?? {};
  if (hooks[EVENT] !== undefined && !Array.isArray(hooks[EVENT])) return tr('"hooks.{0}" in an unknown format; nothing was changed', [EVENT]);
  return { hooks, list: (hooks[EVENT] as unknown[] | undefined) ?? [] };
}

/** List without Habblaud hooks (groups left empty are removed); `removed` = count removed. */
function withoutOurs(list: unknown[]): { list: unknown[]; removed: number } {
  let removed = 0;
  const out: unknown[] = [];
  for (const g of list) {
    const group = rec(g);
    if (!group || !Array.isArray(group.hooks)) {
      out.push(g);
      continue;
    }
    const kept = group.hooks.filter((h) => !isOurHook(h));
    removed += group.hooks.length - kept.length;
    if (kept.length === group.hooks.length) out.push(g);
    else if (kept.length) out.push({ ...group, hooks: kept });
  }
  return { list: out, removed };
}

/** Install plan for a previously read settings.json (does not write anything). */
export function planInstall(settings: Settings, entry: Rec): PlanAction {
  const ev = eventList(settings);
  if (typeof ev === 'string') return { action: 'skip', message: ev };
  const mine = ev.list.flatMap((g) => {
    const group = rec(g);
    return group && Array.isArray(group.hooks) ? group.hooks.filter(isOurHook).map((h) => ({ group, hook: h as Rec })) : [];
  });
  const matchAll = (m: unknown) => m === undefined || m === '' || m === '*';
  if (mine.length === 1 && matchAll(mine[0].group.matcher) && JSON.stringify(mine[0].hook) === JSON.stringify(entry)) {
    return { action: 'none', message: tr('already installed') };
  }
  const rest = withoutOurs(ev.list).list;
  const next: Settings = { ...settings, hooks: { ...ev.hooks, [EVENT]: [...rest, { matcher: '*', hooks: [entry] }] } };
  return { action: 'install', settings: next, message: mine.length ? tr('updated (new Habblaud path, node path or options)') : tr('installed') };
}

/** Uninstall plan: removes only Habblaud hooks (and anything left empty as a result). */
export function planUninstall(settings: Settings): PlanAction {
  const ev = eventList(settings);
  if (typeof ev === 'string') return { action: 'skip', message: ev };
  const { list, removed } = withoutOurs(ev.list);
  if (!removed) return { action: 'none', message: tr("wasn't installed") };
  const hooks: Rec = { ...ev.hooks };
  if (list.length) hooks[EVENT] = list;
  else delete hooks[EVENT];
  const next: Settings = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { action: 'uninstall', settings: next, message: tr('Habblaud hook removed') };
}

/** Installed Habblaud hook in this account (the first), or undefined. */
export function installedHook(settings: Settings): Rec | undefined {
  const ev = eventList(settings);
  if (typeof ev === 'string') return undefined;
  for (const g of ev.list) {
    const hooks = rec(g)?.hooks;
    if (!Array.isArray(hooks)) continue;
    const h = hooks.find(isOurHook);
    if (h) return h as Rec;
  }
  return undefined;
}

/** Script path in an installed command (quoted with double/single quotes, or unquoted). */
export function scriptPathOf(command: string): string | undefined {
  const m = /("[^"]*permission-hook\.mjs"|'(?:[^']|'\\'')*permission-hook\.mjs'|\S*permission-hook\.mjs)/.exec(command);
  if (!m) return undefined;
  const q = m[1];
  if (q.startsWith('"')) return q.slice(1, -1);
  if (q.startsWith("'")) return q.slice(1, -1).replace(/'\\''/g, "'");
  return q;
}

// ---------------------------------------------------------------------------------------------
// Effects (files and Habblaud /api/health)
// ---------------------------------------------------------------------------------------------

export interface RunOptions extends HookOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  nodeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
  /** Queries Habblaud /api/health (tests inject a mock). */
  health?: (port: number) => Promise<{ permissions?: boolean } | undefined>;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let nodeCmd: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let timeoutS = DEFAULT_TIMEOUT_S;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--node') {
      nodeCmd = argv[++i];
      if (!nodeCmd) throw new FatalError(tr('--node needs a path.'));
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port needs a number between 1 and 65535.'));
    } else if (a === '--timeout') {
      timeoutS = Number(argv[++i]);
      if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > 86_400) throw new FatalError(tr('--timeout needs a number of seconds between 5 and 86400 (24 h).'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('specify what to do: install, uninstall or status.\n\n{0}', [USAGE]));
  return { command, dryRun, nodeCmd, port, timeoutS };
}

async function fetchHealth(port: number): Promise<{ permissions?: boolean } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as { permissions?: boolean };
  } catch {
    return undefined;
  }
}

/** Runs the command for all accounts. Returns exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = discoverClaudeDirs(env, home);
  if (!dirs.length) {
    out(tr("No Claude Code account found (~/.claude* with projects/ or sessions/). Use HABBLAUD_CLAUDE_DIRS if they're somewhere else."));
    return 1;
  }
  const nodeCmd = opts.nodeCmd ?? detectNodeCommand(env, home);
  const entry = hookEntry(hookCommand(nodeCmd, ctx.hookPath, opts), opts);
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
      const h = installedHook(read.settings);
      if (!h) {
        out(tr('• {0}: not installed', [label]));
        continue;
      }
      const path = typeof h.command === 'string' ? scriptPathOf(h.command) : undefined;
      if (path && resolve(path) !== resolve(ctx.hookPath)) {
        const gone = !existsSync(path) ? tr(' (that file no longer exists: the hook fails and only the terminal counts)') : '';
        out(tr('! {0}: the hook points to {1}{2}; run npm run hooks:install to update', [label, path, gone]));
      }
      out(tr('• {0}: installed ({1}; timeout {2} s)', [label, String(h.command), String(h.timeout ?? '?')]));
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, entry) : planUninstall(read.settings);
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
      out(`    hooks.${EVENT} → ${JSON.stringify(rec(plan.settings.hooks)?.[EVENT] ?? null)}`);
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
  if (opts.command === 'status') {
    const health = await (ctx.health ?? fetchHealth)(opts.port);
    if (!health) out(tr("Habblaud at http://127.0.0.1:{0}: down (while it's stopped, the hook exits right away and the terminal works as usual).", [opts.port]));
    else if (health.permissions) out(tr('Habblaud at http://127.0.0.1:{0}: handling permission requests (with a page open).', [opts.port]));
    else out(tr('Habblaud at http://127.0.0.1:{0}: up, but answering from the office is off (port exposed on the network or HABBLAUD_TERMINAL=0).', [opts.port]));
  }
  if (opts.command === 'install' && changed) {
    out('');
    out(tr('Done. With Habblaud open in the browser, permission requests show up in the office and you'));
    out(tr('can approve or deny them there; the dialog stays in the terminal and whichever answer comes first wins.'));
    out(tr('Open sessions usually reload settings.json on their own; if not, reopen the session.'));
    out(tr('To undo: npm run hooks:uninstall'));
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
  process.exitCode = await run(parsed, { env: process.env, home, now: new Date(), hookPath: HOOK_SCRIPT, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[hooks] Error: {0}', [err.message]) : tr('[hooks] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
