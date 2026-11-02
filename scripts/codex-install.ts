// Installs (or removes) Habblaud hooks in OpenAI Codex (`codex` CLI and desktop app). Runs on the HOST, with tsx:
//
//   npm run codex:install     # adds Habblaud groups to <CODEX_HOME>/hooks.json (backs up first)
//   npm run codex:uninstall   # removes only Habblaud groups (other hooks stay)
//   npm run codex:status      # shows, per folder, if groups are present and whether Habblaud responds
//   (options: --dry-run, --conta <id>, --port <n>, --espera <s>)
//
// The hook (mod/habblaud-codex/hook.mjs) notifies the office of Codex session actions (SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, SessionEnd) and allows approving
// or denying approval requests (PermissionRequest) from the office: Codex waits for the hook up to the configured
// wait time (default 25 s) and, without a decision, falls back to standard terminal approval.
//
// Folders: the same Codex accounts tracked by the server: HABBLAUD_CODEX_DIRS (comma-separated list; overrides all)
// or CODEX_HOME and Codex ~/.codex* folders (isCodexHome). Claude Code folders are never touched.
//
// In <folder>/hooks.json ({description?, hooks: {<Event>: [{matcher?, hooks: [handler]}]}}), only the lists for
// the events above change: a matcherless group with handler
// {type: "command", command: 'node "<Habblaud>/mod/habblaud-codex/hook.mjs"', ...} is appended to the END of each list.
// The rest of the file stays unchanged. Before writing, a backup is saved to hooks.json.habblaud-backup-<date>.
//
// Trust: Codex only runs a new or modified hook after approval in /hooks, storing approval in config.toml
// ([hooks.state."<hooks.json>:<event>:<group>:<handler>"].trusted_hash) by group POSITION and a hash of event,
// matcher, and handler (command, timeout, async, statusMessage). Therefore the installer:
// - never writes trust nor edits config.toml (approval is done by you in /hooks);
// - always APPENDS to the end and, on update, replaces the Habblaud handler IN PLACE: groups from other apps
//   (e.g. Orca) never shift position or change content;
// - uses a command without flags and with fixed values (port and wait in ~/.habblaud/codex-hook.json, read by hook):
//   changing port needs no re-approval; changing wait changes PermissionRequest timeout and asks for approval.
// Running again does not duplicate (the Habblaud group is recognized by its command).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { discoverCodexDirs } from '../server/sources/codex/accounts';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-codex', 'hook.mjs');
/** Habblaud hook is recognized by script path in command (in any repository folder). */
const HOOK_MARK = /habblaud-codex[\\/]+hook\.mjs/;
export const DEFAULT_PORT = 4747;
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Observation-only events: background (async), without delaying the session. */
export const OBSERVE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'] as const;
/** All events handled by Habblaud. */
export const EVENTS = [...OBSERVE_EVENTS, 'SessionEnd', 'PermissionRequest'] as const;
/** Timeout for observation events (the hook posts the event with a 1.5 s deadline). */
export const OBSERVE_TIMEOUT_S = 5;
/** SessionEnd: Codex always runs it in foreground, default 1 s (max 3). */
export const SESSION_END_TIMEOUT_S = 1;
/** PermissionRequest timeout slack over wait time (node startup, event and registration; hook gives up earlier). */
export const PERMISSION_SLACK_S = 10;
export const STATUS_MESSAGE = tr('Waiting for an answer in Habblaud…');
/** Configuration read by the hook (port and wait), in ~/.habblaud. */
export const CONFIG_NAME = 'codex-hook.json';

/** Minimum Node version for hook (matching Habblaud `engines` for relevant features: fetch and AbortSignal). */
export const MIN_NODE_MAJOR = 22;

const USAGE = tr("Usage: npm run codex:<install|uninstall|status> [-- options]\n\n  install     adds the Habblaud hooks to the hooks.json in each Codex folder (backs it up first)\n  uninstall   removes the Habblaud hooks from each folder (other hooks stay)\n  status      shows whether the hooks are there and whether Habblaud is responding\n\nOptions:\n  --dry-run        shows what would change, without writing anything\n  --conta <id>     only this account's folder (the folder name, e.g. .codex)\n  --port <n>       Habblaud port (default: HABBLAUD_PORT or {0})\n  --espera <s>     how long Codex waits for your answer in Habblaud before asking for approval in the terminal\n                   (default: {1} s; between {2} and {3})\n  --node <path>    the Node {4}+ that runs the hooks (default: the login shell's `node`, if it is {5}+;\n                   otherwise the first {6}+ among /opt/homebrew/bin, /usr/local/bin and the one running this command)\n  -h, --help       shows this help\n\nFolders: HABBLAUD_CODEX_DIRS (comma-separated list) or CODEX_HOME and Codex's ~/.codex* folders.\nAfter installing, open Codex and approve the Habblaud hooks in /hooks.", [DEFAULT_PORT, DEFAULT_WAIT_S, MIN_WAIT_S, MAX_WAIT_S, MIN_NODE_MAJOR, MIN_NODE_MAJOR, MIN_NODE_MAJOR]);

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/codex-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/**
 * `node "<hook>"` (or `"<node>" "<hook>"` with a chosen Node, see chooseNode), without options: the command enters
 * the Codex trust hash.
 */
export function hookCommand(scriptPath: string, nodeBin?: string): string {
  return `${nodeBin ? quotePath(nodeBin) : 'node'} ${quotePath(scriptPath)}`;
}

/** Major version as printed by `node --version` ("v24.17.0" → 24). */
export function nodeMajor(version: string | undefined): number | undefined {
  const m = /^v?(\d+)\./.exec(version?.trim() ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Node for hooks. Codex runs the hook via `$SHELL -lc`: a LOGIN shell, which in zsh skips .zshrc (where nvm
 * usually lives), so its `node` may be different and outdated. `probe(undefined)` = `node` version in that shell;
 * `probe(path)` = version of that binary. Login shell with Node 22+: `node` (short command, survives version
 * switches). Otherwise, first 22+ candidate with absolute path; none: `node` with a warning.
 */
export function chooseNode(probe: (bin: string | undefined) => string | undefined, candidates: readonly string[]): { bin?: string; login?: string; chosen?: string } {
  const login = probe(undefined);
  if ((nodeMajor(login) ?? 0) >= MIN_NODE_MAJOR) return { login };
  for (const bin of candidates) {
    const v = probe(bin);
    if ((nodeMajor(v) ?? 0) >= MIN_NODE_MAJOR) return { bin, login, chosen: v };
  }
  return { login };
}

/** PermissionRequest timeout for a given wait (s). */
export function permissionTimeout(waitS: number): number {
  return waitS + PERMISSION_SLACK_S;
}

/** Habblaud handler for an event, as read by Codex in hooks.<Event>[].hooks[]. */
export function handlerFor(event: string, command: string, waitS: number): Rec {
  if (event === 'PermissionRequest') return { type: 'command', command, timeout: permissionTimeout(waitS), statusMessage: STATUS_MESSAGE };
  if (event === 'SessionEnd') return { type: 'command', command, timeout: SESSION_END_TIMEOUT_S };
  return { type: 'command', command, async: true, timeout: OBSERVE_TIMEOUT_S };
}

export function isOurHandler(h: unknown): boolean {
  const r = rec(h);
  return !!r && typeof r.command === 'string' && HOOK_MARK.test(r.command);
}

/** JSON with sorted keys (to compare handlers independently of serialization order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = rec(v);
  if (!r) return JSON.stringify(v) ?? 'null';
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
    .join(',')}}`;
}

/** Script path in an installed command (quoted with double/single quotes, or unquoted). */
export function scriptPathOf(command: string): string | undefined {
  const m = /("[^"]*habblaud-codex[\\/]+hook\.mjs"|'(?:[^']|'\\'')*habblaud-codex[\\/]+hook\.mjs'|\S*habblaud-codex[\\/]+hook\.mjs)/.exec(command);
  if (!m) return undefined;
  const q = m[1];
  if (q.startsWith('"')) return q.slice(1, -1);
  if (q.startsWith("'")) return q.slice(1, -1).replace(/'\\''/g, "'");
  return q;
}

export type PlanAction =
  | { action: 'install'; file: Settings; message: string; /** Approve in /hooks. */ approve: string[] }
  | { action: 'uninstall'; file: Settings; message: string; /** Shifted groups. */ shifted: string[] }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** `hooks` in an editable format (or reason not to touch). */
function hooksOf(file: Settings): Rec | string {
  if (file.hooks !== undefined && !rec(file.hooks)) return tr('"hooks" in an unknown format; nothing was changed');
  const hooks = rec(file.hooks) ?? {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) return tr('"hooks.{0}" in an unknown format; nothing was changed', [event]);
  }
  return hooks;
}

/** Positions (group, handler) of Habblaud handlers in a group list, in order. */
function ourPositions(list: unknown[]): Array<{ g: number; h: number }> {
  const out: Array<{ g: number; h: number }> = [];
  list.forEach((g, gi) => {
    const hooks = rec(g)?.hooks;
    if (Array.isArray(hooks)) hooks.forEach((h, hi) => isOurHandler(h) && out.push({ g: gi, h: hi }));
  });
  return out;
}

/** Positions (group:handler) of OTHER app handlers, in order: their trust key in Codex. */
function otherPositions(list: unknown[]): string {
  const out: string[] = [];
  list.forEach((g, gi) => {
    const hooks = rec(g)?.hooks;
    if (Array.isArray(hooks)) hooks.forEach((h, hi) => !isOurHandler(h) && out.push(`${gi}:${hi}`));
  });
  return out.join(',');
}

/** Removes handlers at given positions (end to start to keep indices intact); groups left empty are removed. */
function removeAt(list: unknown[], positions: Array<{ g: number; h: number }>): unknown[] {
  const out = [...list];
  const byGroup = new Map<number, number[]>();
  for (const p of positions) byGroup.set(p.g, [...(byGroup.get(p.g) ?? []), p.h]);
  for (const g of [...byGroup.keys()].sort((a, b) => b - a)) {
    const group = rec(out[g])!;
    const drop = new Set(byGroup.get(g));
    const kept = (group.hooks as unknown[]).filter((_, i) => !drop.has(i));
    if (kept.length) out[g] = { ...group, hooks: kept };
    else out.splice(g, 1);
  }
  return out;
}

/**
 * Install plan for a previously read hooks.json (does not write anything). Event without Habblaud: a new group
 * at the END of the list. With it: handler is replaced IN PLACE if changed (repo path, wait); duplicates removed.
 */
export function planInstall(file: Settings, command: string, waitS: number): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of EVENTS) {
    const handler = handlerFor(event, command, waitS);
    let list = [...((hooks[event] as unknown[] | undefined) ?? [])];
    const found = ourPositions(list);
    if (!found.length) {
      list.push({ hooks: [handler] });
      added.push(event);
    } else {
      const first = found[0];
      const group = rec(list[first.g])!;
      const handlers = [...(group.hooks as unknown[])];
      let changed = false;
      if (canonical(handlers[first.h]) !== canonical(handler)) {
        handlers[first.h] = handler;
        list[first.g] = { ...group, hooks: handlers };
        changed = true;
      }
      // Duplicate copies (hand-edited): hook would run twice.
      if (found.length > 1) {
        list = removeAt(list, found.slice(1));
        changed = true;
      }
      if (changed) updated.push(event);
    }
    hooks[event] = list;
  }
  if (!added.length && !updated.length) return { action: 'none', message: tr('already installed') };
  const parts = [added.length ? (updated.length ? tr('installed in {0}', [added.join(', ')]) : tr('installed ({0} events)', [added.length])) : '', updated.length ? tr('updated in {0}', [updated.join(', ')]) : ''].filter(Boolean);
  return { action: 'install', file: { ...file, hooks }, message: parts.join('; '), approve: [...added, ...updated] };
}

/**
 * Uninstall plan: removes only Habblaud handlers (and groups emptied as a result; an event list that empties
 * is deleted, and `hooks` as well if empty). Other apps' groups that came AFTER a Habblaud group shift up one
 * position: Codex asks to approve them again in /hooks (`shifted`).
 */
export function planUninstall(file: Settings): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  let removed = 0;
  const shifted: string[] = [];
  for (const [event, raw] of Object.entries(hooks)) {
    const list = raw as unknown[];
    const found = ourPositions(list);
    if (!found.length) continue;
    const next = removeAt(list, found);
    removed += found.length;
    // Did another app's handler shift position (came after a Habblaud one)?
    if (otherPositions(list) !== otherPositions(next)) shifted.push(event);
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  if (!removed) return { action: 'none', message: tr("wasn't installed") };
  const next: Settings = { ...file };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { action: 'uninstall', file: next, message: tr('Habblaud hooks removed'), shifted };
}

export interface InstallState {
  /** Events with Habblaud handler matching expected. */
  ok: string[];
  /** Events with different Habblaud handler (different path or wait). */
  outdated: string[];
  missing: string[];
  /** Script paths in installed handlers. */
  paths: string[];
}

/** What is installed in a hooks.json (for status). */
export function installState(file: Settings, command: string, waitS: number): InstallState {
  const parsed = hooksOf(file);
  const hooks = typeof parsed === 'string' ? {} : parsed;
  const state: InstallState = { ok: [], outdated: [], missing: [], paths: [] };
  for (const event of EVENTS) {
    const list = (hooks[event] as unknown[] | undefined) ?? [];
    const found = ourPositions(list);
    if (!found.length) {
      state.missing.push(event);
      continue;
    }
    const group = rec(list[found[0].g])!;
    const h = rec((group.hooks as unknown[])[found[0].h])!;
    const path = typeof h.command === 'string' ? scriptPathOf(h.command) : undefined;
    if (path && !state.paths.includes(path)) state.paths.push(path);
    (canonical(h) === canonical(handlerFor(event, command, waitS)) && found.length === 1 ? state.ok : state.outdated).push(event);
  }
  return state;
}

/**
 * Codex folders: SAME ones tracked by server (discoverCodexDirs from Codex source: HABBLAUD_CODEX_DIRS, which
 * overrides all, or CODEX_HOME and ~/.codex* folders looking like Codex; ~/.codex first). Claude Code folders
 * listed by mistake are excluded (`refused`).
 */
export function discoverCodexHomes(env: NodeJS.ProcessEnv, home: string): { dirs: string[]; refused: string[] } {
  const dirs: string[] = [];
  const refused: string[] = [];
  for (const p of discoverCodexDirs(env, home)) (isClaudeDir(p) ? refused : dirs).push(p);
  return { dirs, refused };
}

// ---------------------------------------------------------------------------------------------
// Effects (files and Habblaud /api/health)
// ---------------------------------------------------------------------------------------------

export interface HookConfig {
  port: number;
  permissionTimeoutS: number;
}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** Only this account's folder (basename). */
  account?: string;
  port: number;
  waitS: number;
  /** --node: Node for hooks, with absolute path (without it, chooseNode). */
  node?: string;
}

export interface Health {
  permissions?: boolean;
  messages?: boolean;
  codexEvents?: boolean;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
  /** Queries Habblaud /api/health (tests inject a mock). */
  health?: (port: number) => Promise<Health | undefined>;
  /** Version of a Node (see chooseNode); absent = skips probe and uses `node` (tests do not run shells). */
  nodeProbe?: (bin: string | undefined) => string | undefined;
  /** Candidate Node binaries when login shell has an outdated one. */
  nodeCandidates?: readonly string[];
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let account: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let waitS = DEFAULT_WAIT_S;
  let node: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--conta') {
      account = argv[++i];
      if (!account) throw new FatalError(tr('--conta needs the account folder name (e.g. .codex).'));
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port needs a number between 1 and 65535.'));
    } else if (a === '--espera') {
      waitS = Number(argv[++i]);
      if (!Number.isInteger(waitS) || waitS < MIN_WAIT_S || waitS > MAX_WAIT_S) throw new FatalError(tr('--espera needs a number of seconds between {0} and {1}.', [MIN_WAIT_S, MAX_WAIT_S]));
    } else if (a === '--node') {
      node = argv[++i];
      if (!node || !isAbsolute(node)) throw new FatalError(tr('--node needs the absolute path to a Node 22+ (e.g. /opt/homebrew/bin/node).'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('specify what to do: install, uninstall or status.\n\n{0}', [USAGE]));
  return { command, dryRun, account, port, waitS, ...(node ? { node } : {}) };
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

/** Configuration saved for hook (undefined = missing or unreadable). */
export function readHookConfig(home: string): Partial<HookConfig> | undefined {
  try {
    const j = rec(JSON.parse(readFileSync(configPath(home), 'utf8')));
    if (!j) return undefined;
    const out: Partial<HookConfig> = {};
    if (typeof j.port === 'number') out.port = j.port;
    if (typeof j.permissionTimeoutS === 'number') out.permissionTimeoutS = j.permissionTimeoutS;
    return out;
  } catch {
    return undefined;
  }
}

/** Writes hook configuration if changed. Returns true if written. */
function writeHookConfig(home: string, cfg: HookConfig): boolean {
  const cur = readHookConfig(home);
  if (cur?.port === cfg.port && cur.permissionTimeoutS === cfg.permissionTimeoutS) return false;
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
  return true;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

/** Runs the command for all Codex folders. Returns exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const found = discoverCodexHomes(env, home);
  for (const p of found.refused) out(tr("! {0}: it's a Claude Code folder, not a Codex one; skipped.", [tildify(p, home)]));
  const dirs = opts.account ? found.dirs.filter((d) => basename(d) === opts.account) : found.dirs;
  if (!dirs.length) {
    out(
      opts.account
        ? tr('No Codex folder named {0} (folders found: {1}).', [opts.account, found.dirs.map((d) => basename(d)).join(', ') || tr('none')])
        : tr("No Codex folder found (~/.codex or CODEX_HOME). Use HABBLAUD_CODEX_DIRS if it's somewhere else."),
    );
    return 1;
  }
  let nodeBin = opts.node;
  if (!nodeBin && ctx.nodeProbe) {
    const pick = chooseNode(ctx.nodeProbe, ctx.nodeCandidates ?? []);
    nodeBin = pick.bin;
    const login = pick.login ? `Node ${pick.login}` : tr('no Node');
    if (pick.bin) out(tr('i The login shell (where Codex runs the hooks) has {0}; the hook needs {1}+ and will use {2} ({3}).', [login, MIN_NODE_MAJOR, tildify(pick.bin, home), pick.chosen]));
    else if ((nodeMajor(pick.login) ?? 0) < MIN_NODE_MAJOR)
      out(tr('! The login shell (where Codex runs the hooks) has {0} and no Node {1}+ was found: the hooks may fail. Use --node <path to a Node {2}+>.', [login, MIN_NODE_MAJOR, MIN_NODE_MAJOR]));
  }
  const command = hookCommand(ctx.hookPath, nodeBin);
  let failures = 0;
  let changed = 0;
  const approve = new Set<string>();
  for (const dir of dirs) {
    const file = join(dir, 'hooks.json');
    const label = `${basename(dir)} (${tildify(file, home)})`;
    const read = readSettings(file);
    if ('error' in read) {
      out(`✗ ${label}: ${read.error}`);
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const cfgWait = readHookConfig(home)?.permissionTimeoutS;
      const st = installState(read.settings, command, typeof cfgWait === 'number' ? cfgWait : opts.waitS);
      if (!st.ok.length && !st.outdated.length) {
        out(tr('• {0}: not installed', [label]));
        continue;
      }
      for (const p of st.paths) {
        if (resolve(p) === resolve(ctx.hookPath)) continue;
        const gone = !existsSync(p) ? tr(' (that file no longer exists: the hooks fail and nothing reaches the office)') : '';
        out(tr('! {0}: the hooks point to {1}{2}; run npm run codex:install to update', [label, p, gone]));
      }
      if (st.outdated.length) out(tr('! {0}: not as expected in {1}; run npm run codex:install to update', [label, st.outdated.join(', ')]));
      if (st.missing.length) out(tr('! {0}: missing in {1}; run npm run codex:install', [label, st.missing.join(', ')]));
      out(tr('• {0}: installed on {1} of {2} events', [label, st.ok.length + st.outdated.length, EVENTS.length]));
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, command, opts.waitS) : planUninstall(read.settings);
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
      out(`    hooks → ${JSON.stringify(plan.file.hooks ?? null)}`);
      continue;
    }
    try {
      const backup = writeSettings(file, plan.file, read.raw, ctx.now);
      out(`✓ ${label}: ${plan.message}${backup ? tr(' · backup in {0}', [tildify(backup, home)]) : ''}`);
      changed++;
      if (plan.action === 'install') for (const e of plan.approve) approve.add(e);
      if (plan.action === 'uninstall' && plan.shifted.length) {
        out(tr("    Hooks from other apps that came after Habblaud's ({0}) changed position:", [plan.shifted.join(', ')]));
        out(tr('    Codex will ask you to approve them again in /hooks.'));
      }
    } catch (err) {
      out(tr("✗ {0}: couldn't write ({1})", [label, (err as Error).message]));
      failures++;
    }
  }
  const cfgFile = tildify(configPath(home), home);
  if (opts.command === 'install') {
    const cfg: HookConfig = { port: opts.port, permissionTimeoutS: opts.waitS };
    if (opts.dryRun) out(tr('~ hook config ({0}): port {1}, wait {2} s (dry run: nothing written)', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
    else {
      try {
        if (writeHookConfig(home, cfg)) out(tr('✓ hook config written to {0} (port {1}, wait {2} s)', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
        else out(tr('= hook config ({0}): port {1}, wait {2} s', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
      } catch (err) {
        out(tr("✗ couldn't write {0} ({1}): the hook uses port {2} and waits {3} s", [cfgFile, (err as Error).message, DEFAULT_PORT, DEFAULT_WAIT_S]));
        failures++;
      }
    }
  }
  if (opts.command === 'status') {
    const cfg = readHookConfig(home);
    out(
      cfg
        ? tr('Hook config ({0}): port {1}, wait {2} s.', [cfgFile, cfg.port ?? DEFAULT_PORT, cfg.permissionTimeoutS ?? DEFAULT_WAIT_S])
        : tr('Hook config ({0}): missing (the hook uses HABBLAUD_PORT or port {1} and waits {2} s).', [cfgFile, DEFAULT_PORT, DEFAULT_WAIT_S]),
    );
    const port = cfg?.port ?? opts.port;
    const health = await (ctx.health ?? fetchHealth)(port);
    if (!health) out(tr("Habblaud at http://127.0.0.1:{0}: down (while it's stopped, the hooks exit right away and Codex works as usual).", [port]));
    else {
      const events = health.codexEvents ? tr('receiving Codex events') : tr('up, but without the Codex source (events are ignored)');
      const perms = health.permissions ? tr('office approvals on (with a page open)') : tr('office approvals off (port exposed on the network or HABBLAUD_TERMINAL=0)');
      out(tr('Habblaud at http://127.0.0.1:{0}: {1}; {2}.', [port, events, perms]));
    }
    out(tr('Trust: Codex only runs a new or changed hook after you approve it; check /hooks inside Codex.'));
  }
  if (opts.command === 'install' && opts.account && !opts.dryRun) {
    // Wait is in a single config file, but PermissionRequest timeout lives in each hooks.json: other folders with
    // Habblaud and a different wait would cut the hook off prematurely.
    const behind = found.dirs.filter((d) => {
      if (dirs.includes(d)) return false;
      const r = readSettings(join(d, 'hooks.json'));
      return !('error' in r) && installState(r.settings, command, opts.waitS).outdated.includes('PermissionRequest');
    });
    if (behind.length) {
      out(tr('! {0}: Habblaud is there with a different wait; run npm run codex:install without --conta to align.', [behind.map((d) => basename(d)).join(', ')]));
    }
  }
  if (opts.command === 'install' && approve.size && !opts.dryRun) {
    out('');
    out(tr('Done. One step left: open Codex and approve the Habblaud hooks in /hooks (Codex only runs a new'));
    out(tr('or changed hook after you approve it). With Habblaud open in the browser, Codex sessions show up in the'));
    out(tr('office and approval requests wait for your answer there for up to {0} s before going to the terminal.', [opts.waitS]));
    if (approve.has('PermissionRequest') && approve.size < EVENTS.length) {
      out(tr('(The wait or the Habblaud path changed: approve the changed hooks again in /hooks.)'));
    }
    out(tr('To undo: npm run codex:uninstall'));
  }
  if (opts.command === 'uninstall' && changed) out(tr('The config in ~/.habblaud/codex-hook.json stays (only the hook reads it).'));
  return failures ? 1 : 0;
}

/** Node version: from Codex login shell (`$SHELL -lc`, bin absent) or a path. Failure = undefined. */
function probeNode(bin: string | undefined): string | undefined {
  try {
    const opts = { encoding: 'utf8' as const, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    const out = bin ? execFileSync(bin, ['--version'], opts) : execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'node --version'], opts);
    return out.trim().split('\n').pop();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    hookPath: HOOK_SCRIPT,
    out: (l) => console.log(l),
    nodeProbe: probeNode,
    nodeCandidates: ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[codex] Error: {0}', [err.message]) : tr('[codex] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
