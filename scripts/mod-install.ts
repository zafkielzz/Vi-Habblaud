// Installs (or removes) the Habblaud mod in each account's Claude Code. Runs on the HOST, with tsx:
//
//   npm run mod:install      # "habblaud" marketplace (this folder) + plugins habblaud, habblaud-permissoes and
//                            # habblaud-mensagens
//   npm run mod:uninstall    # removes the three plugins and the marketplace from each account
//   npm run mod:status       # per account: marketplace, plugins (and versions) and remnants of the legacy way
//   (options: --sem-permissoes, --sem-mensagens, --conta <folder>, --dry-run, --claude <command>)
//
// Everything goes through Claude Code's own CLI (`claude plugin ...`), run once per account with that account's
// CLAUDE_CONFIG_DIR, like the shell alias does (`alias d='CLAUDE_CONFIG_DIR=... claude'`). That way
// Claude Code records the registrations (enabledPlugins and extraKnownMarketplaces in settings.json,
// <account>/plugins/*.json) in its own format: this script does not edit those fields.
//
// The marketplace is THIS folder (.claude-plugin/marketplace.json at repo root), added as a local directory:
// Claude Code loads plugins directly from folders in mod/, without copying. After a `git pull`, new
// sessions (or /reload-plugins) already run the new code; `claude plugin update` updates the registered version
// (`npm run docker:up` does this automatically for existing installs).
//
// Messages from the office (habblaud-mensagens, the plugin that types into the session on your behalf): included by
// default; excluded with --sem-mensagens, and an already installed one stays (like permissions with --sem-permissoes).
// docker:up never installs it on its own: on an account with mod but without it, it only suggests running mod:install.
//
// Migration from the legacy way: the mod writes usage to the same file as the statusline tap (usage:install) and the
// permissions plugin does the same as the PermissionRequest settings hook (hooks:install). On install, each is
// removed from the account's settings.json (with backup) via legacy installer functions, preventing double usage
// capture or two responders for the same request. With --sem-permissoes, the legacy hook remains as is.
//
// Legacy name (CodeTown, up to 0.3.2): install removes plugins codetown and codetown-permissoes and marketplace
// codetown (this same folder, under its former name) BEFORE adding habblaud, and moves ~/.codetown to
// ~/.habblaud. uninstall also removes them, status shows them, and docker:up only warns.
//
// Status (and each account's plan): comes from `claude plugin list --json` and `claude plugin marketplace list --json`,
// documented outputs that already resolve scope, enabled/disabled, and CLAUDE_CODE_PLUGIN_CACHE_DIR.
// <account>/plugins/installed_plugins.json and known_marketplaces.json are Claude Code internals and may change
// format (the former is already on version 2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs, expandHome, isDefaultDir } from '../server/accounts/detect';
import { LEGACY_NAME } from '../server/legacy';
import { DEFAULT_PORT, installedHook, planUninstall as planHookUninstall } from './hooks-install';
import {
  formatAge,
  isTapCommand,
  migrateLegacyState,
  planUninstall as planTapUninstall,
  readSettings,
  tildify,
  usageDirOf,
  writeSettings,
  type Settings,
} from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Marketplace name in .claude-plugin/marketplace.json (contract with mod/). */
export const MARKETPLACE = 'habblaud';
/** The mod: plan usage, "needs you" terminal notice and /habblaud. */
export const MOD_PLUGIN = `habblaud@${MARKETPLACE}`;
/** The PermissionRequest settings hook to answer from the office, packaged as a plugin. */
export const PERMISSIONS_PLUGIN = `habblaud-permissoes@${MARKETPLACE}`;
/** Send messages from the office: relays messages typed in Habblaud to the session as yours. */
export const MESSAGES_PLUGIN = `habblaud-mensagens@${MARKETPLACE}`;
/** Habblaud plugins in output order (status, removal, update). */
export const PLUGINS = [MOD_PLUGIN, PERMISSIONS_PLUGIN, MESSAGES_PLUGIN] as const;
/** Marketplace under legacy name (CodeTown, up to 0.3.2): same folder, registered with its former name. */
export const LEGACY_MARKETPLACE = LEGACY_NAME;
/** Plugins that came from it (the mod and permissions plugin, under legacy name). */
export const LEGACY_PLUGINS = [`${LEGACY_NAME}@${LEGACY_MARKETPLACE}`, `${LEGACY_NAME}-permissoes@${LEGACY_MARKETPLACE}`] as const;
/** First Claude Code version (terminal) that loads mods. */
export const MIN_CLAUDE_VERSION = '2.1.287';
/** Plugins always go into user scope: valid in all projects of the account. */
const SCOPE = 'user';
/** Timeout for each CLI call (add/update of a local directory takes a few seconds). */
const CLI_TIMEOUT_MS = 120_000;

const USAGE = tr("Usage: npm run mod:<install|uninstall|status> [-- options]\n\n  install     installs the Habblaud mod into each account's Claude Code (this folder's marketplace + plugins)\n              and removes what it replaces: the old statusline tap, the old permission hook and the mod under\n              the old name (codetown)\n  uninstall   removes the Habblaud plugins and marketplace from each account (and the old-name ones, if any are left)\n  status      shows, per account, the marketplace, the plugins (and versions) and what's left of the old way\n\nOptions:\n  --sem-permissoes   doesn't install the plugin for answering permissions from the office (and keeps the old hook)\n  --sem-mensagens    doesn't install the plugin for sending messages from the office (one already installed stays)\n  --conta <folder>   only this account (e.g. --conta ~/.claude-conta2); can be repeated\n  --dry-run          shows what it would do, without installing or writing anything\n  --claude <cmd>     Claude Code command (default: claude, from PATH)\n  -h, --help         shows this help\n\nRequires Claude Code {0} or newer. On earlier versions, use the old way:\nnpm run usage:install (live usage) and npm run hooks:install (answer permissions); sending messages from the\noffice only exists with the mod.\n\nAccounts: the same as the server's (~/.claude* with projects/ or sessions/, CLAUDE_CONFIG_DIR or\nHABBLAUD_CLAUDE_DIRS). Usage captured in HABBLAUD_USAGE_DIR (default ~/.habblaud/usage).", [MIN_CLAUDE_VERSION]);

// ---------------------------------------------------------------------------------------------
// Claude Code CLI (injectable: tests never call the real one)
// ---------------------------------------------------------------------------------------------

export interface ClaudeResult {
  /** Exit code (null if never ran or was killed). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Process launch failure (e.g. `claude` not in PATH). */
  error?: string;
}

/** Runs `claude <args>` with given environment (account's CLAUDE_CONFIG_DIR is included). */
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => ClaudeResult;

/** The real runner. Closed stdin: nothing waits for a terminal response. */
export function makeClaudeRunner(cmd = 'claude'): ClaudeRunner {
  return (args, env) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? tr('the "{0}" command wasn\'t found in PATH', [cmd]) : code === 'ETIMEDOUT' ? tr('"{0} {1}" didn\'t finish within {2} s', [cmd, args.join(' '), CLI_TIMEOUT_MS / 1000]) : r.error.message;
      return { code: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
    }
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/**
 * CLI environment for an account. The default account (~/.claude) runs WITHOUT CLAUDE_CONFIG_DIR, like plain `claude`:
 * with the variable pointing to ~/.claude, Claude Code would use ~/.claude/.claude.json instead of
 * ~/.claude.json. And the inherited variable (e.g. running from within another account's session) never leaks.
 */
export function accountEnv(env: NodeJS.ProcessEnv, dir: string, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (isDefaultDir(dir, home)) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/mod-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** "2.1.293 (Claude Code)" → [2, 1, 293]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Without terminal color codes. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * CLI output JSON, with tolerance: entire output, or from first line starting a JSON (warnings
 * before it), or just the last line (result format of action `--json`). undefined if nothing works.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim();
  if (!text) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text);
  if (whole !== undefined) return whole;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start > 0) {
    const fromStart = tryParse(lines.slice(start).join('\n'));
    if (fromStart !== undefined) return fromStart;
  }
  return tryParse(lines[lines.length - 1]);
}

/** A plugin installation, as `claude plugin list --json` shows (only what we use). */
export interface PluginInfo {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  /** Folder it loads from, when read in-place from a local marketplace (Claude Code 2.1.289+). */
  readFromFolder?: string;
  /** Manifest version in that folder (may be newer than registered version). */
  folderVersion?: string;
  errors: string[];
}

/** Installed plugin list; accepts array or `--available` object ({installed: [...]}). */
export function parsePluginList(stdout: string): PluginInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  const list = Array.isArray(raw) ? raw : rec(raw) && Array.isArray(rec(raw)!.installed) ? (rec(raw)!.installed as unknown[]) : undefined;
  if (!list) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out: PluginInfo[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id);
    if (!r || !id) continue;
    out.push({
      id,
      version: str(r.version),
      scope: str(r.scope),
      enabled: r.enabled !== false,
      readFromFolder: str(r.readFromFolder),
      folderVersion: str(r.folderVersion),
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  /** Folder (directory or local file marketplaces). */
  path?: string;
}

export function parseMarketplaceList(stdout: string): MarketplaceInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  if (!Array.isArray(raw)) return undefined;
  const out: MarketplaceInfo[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || typeof r.name !== 'string') continue;
    const m: MarketplaceInfo = { name: r.name };
    if (typeof r.source === 'string') m.source = r.source;
    const path = typeof r.path === 'string' ? r.path : typeof r.installLocation === 'string' && r.source === 'directory' ? r.installLocation : undefined;
    if (path) m.path = path;
    out.push(m);
  }
  return out;
}

/** What an account has of Habblaud in Claude Code. */
export interface AccountState {
  marketplace?: MarketplaceInfo;
  /** Legacy name marketplace (codetown), if still registered. */
  legacyMarketplace?: MarketplaceInfo;
  plugins: PluginInfo[];
}

/** Installation of `id` in user scope (the only one this script manages). */
export function userInstall(state: AccountState, id: string): PluginInfo | undefined {
  return state.plugins.find((p) => p.id === id && (p.scope === SCOPE || p.scope === undefined));
}

/** Legacy name plugins in user scope (where 0.3 mod:install put them). */
export function legacyPlugins(state: AccountState): PluginInfo[] {
  return LEGACY_PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
}

/**
 * Remnants of the legacy name in a phrase ("marketplace codetown, codetown@codetown 0.3.2"), or undefined
 * if nothing remains. `where` describes the marketplace folder (status indicates if it is this one).
 */
export function legacySummary(state: AccountState, where?: (m: MarketplaceInfo) => string): string | undefined {
  const parts = legacyPlugins(state).map((p) => `${p.id}${p.version ? ` ${p.version}` : ''}`);
  const m = state.legacyMarketplace;
  if (m) parts.unshift(`marketplace ${LEGACY_MARKETPLACE}${where ? ` (${where(m)})` : ''}`);
  return parts.length ? parts.join(', ') : undefined;
}

/** A CLI call, with the phrase describing what it does. */
export interface CliStep {
  args: string[];
  /** "habblaud: installed" (becomes ✓, ~ or ✗ in output). */
  message: string;
  /** Plugin that depends on this step (failed = does not count as installed). */
  plugin?: string;
  /** If it fails, subsequent installation steps run anyway (failure still counts in the end). */
  keepGoing?: boolean;
}

/** Plan item in output order: a CLI call or something already correct (becomes "="). */
export type PlanItem = CliStep | { unchanged: string };

export interface InstallPlan {
  items: PlanItem[];
  /** Warnings that do not prevent installation. */
  notes: string[];
  /** Plugins that remain installed if all steps succeed. */
  plugins: string[];
}

/** Only the CLI calls of a plan. */
export function cliSteps(plan: InstallPlan): CliStep[] {
  return plan.items.filter((i): i is CliStep => 'args' in i);
}

export interface PlanOptions {
  /** Repo root (where .claude-plugin/marketplace.json is). */
  root: string;
  /** package.json version (= plugin version). */
  version: string;
  /** Also install permissions plugin. */
  permissions: boolean;
  /** Also install messages plugin. */
  messages: boolean;
  /** Compares folders (default: real path). */
  sameDir?: (a: string, b: string) => boolean;
}

/** Same folder, resolving symlinks when possible. */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const shortName = (id: string) => id.split('@')[0];

/**
 * Steps that remove remnants of legacy name: plugins (user scope) then marketplace. A plugin
 * that fails to uninstall does not block subsequent steps: removing marketplace removes what came from it.
 */
function legacySteps(state: AccountState): CliStep[] {
  const steps: CliStep[] = legacyPlugins(state).map((p) => ({
    args: ['plugin', 'uninstall', p.id, '--scope', SCOPE],
    message: tr('{0} (old name): removed', [shortName(p.id)]),
    keepGoing: true,
  }));
  if (state.legacyMarketplace) {
    steps.push({ args: ['plugin', 'marketplace', 'remove', LEGACY_MARKETPLACE], message: tr('marketplace {0} (old name): removed', [LEGACY_MARKETPLACE]) });
  }
  return steps;
}

/**
 * Installation steps for an account, based on what it already has. Legacy name remnants are removed first.
 * Marketplace is added (or, if it exists, catalog is reloaded; if pointing to another folder, points
 * to this one). Each plugin is installed, re-enabled (if disabled) or updated (if registered version
 * differs from package.json).
 */
export function planInstall(state: AccountState, o: PlanOptions): InstallPlan {
  const same = o.sameDir ?? sameDir;
  const plan: InstallPlan = { items: [], notes: [], plugins: [] };
  // The codetown marketplace points to this same folder: it is removed before habblaud is added,
  // preventing two registered names for the same folder (one no longer in manifest).
  plan.items.push(...legacySteps(state));
  const m = state.marketplace;
  if (!m) {
    plan.items.push({ args: ['plugin', 'marketplace', 'add', o.root], message: tr('marketplace {0}: added (this folder)', [MARKETPLACE]) });
  } else if (m.path && same(m.path, o.root)) {
    plan.items.push({ args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catalog reloaded from this folder', [MARKETPLACE]) });
  } else {
    // Another folder (Habblaud moved) or another source: add with same key changes source and keeps plugins.
    plan.items.push({
      args: ['plugin', 'marketplace', 'add', o.root],
      message: tr('marketplace {0}: now points to this folder (before: {1})', [MARKETPLACE, m.path ?? m.source ?? tr('another source')]),
    });
  }
  const wanted = [MOD_PLUGIN, ...(o.permissions ? [PERMISSIONS_PLUGIN] : []), ...(o.messages ? [MESSAGES_PLUGIN] : [])];
  for (const id of wanted) {
    const name = shortName(id);
    const cur = userInstall(state, id);
    if (!cur) {
      plan.items.push({ args: ['plugin', 'install', id, '--scope', SCOPE], message: tr('{0}: installed', [name]), plugin: id });
      plan.plugins.push(id);
      continue;
    }
    plan.plugins.push(id);
    let touched = false;
    if (!cur.enabled) {
      plan.items.push({ args: ['plugin', 'enable', id, '--scope', SCOPE], message: tr('{0}: re-enabled (was disabled)', [name]), plugin: id });
      touched = true;
    }
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: updated from {1} to {2}', [name, cur.version ?? '?', o.version]), plugin: id });
      touched = true;
    }
    if (!touched) plan.items.push({ unchanged: tr('{0}: already installed at version {1}', [name, o.version]) });
  }
  // With --sem-permissoes (or --sem-mensagens), an already installed plugin stays (and tracks mod version).
  const left: Array<[id: string, flag: string]> = [];
  if (!o.permissions) left.push([PERMISSIONS_PLUGIN, '--sem-permissoes']);
  if (!o.messages) left.push([MESSAGES_PLUGIN, '--sem-mensagens']);
  for (const [id, flag] of left) {
    const cur = userInstall(state, id);
    if (!cur) continue;
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: tr('{0}: updated from {1} to {2}', [shortName(id), cur.version ?? '?', o.version]), plugin: id });
    }
    plan.plugins.push(id);
    plan.notes.push(tr("{0} was already installed and stays ({1} doesn't remove it; to remove it: claude plugin uninstall {2})", [shortName(id), flag, id]));
  }
  return plan;
}

/**
 * Removal steps: remnants of legacy name (if any), user-scope plugins and marketplace, only
 * what exists. (Removing marketplace would already uninstall its plugins, but a step per plugin clarifies output.)
 */
export function planUninstall(state: AccountState): InstallPlan {
  const plan: InstallPlan = { items: [...legacySteps(state)], notes: [], plugins: [] };
  for (const id of PLUGINS) {
    const name = shortName(id);
    if (userInstall(state, id)) plan.items.push({ args: ['plugin', 'uninstall', id, '--scope', SCOPE], message: tr('{0}: removed', [name]), plugin: id });
    else plan.items.push({ unchanged: tr("{0}: wasn't installed", [name]) });
  }
  if (state.marketplace) plan.items.push({ args: ['plugin', 'marketplace', 'remove', MARKETPLACE], message: tr('marketplace {0}: removed', [MARKETPLACE]) });
  else plan.items.push({ unchanged: tr("marketplace {0}: wasn't added", [MARKETPLACE]) });
  return plan;
}

export interface MigrationPlan {
  /** New settings.json, if anything changed. */
  settings?: Settings;
  /** What was removed (becomes ✓). */
  done: string[];
  /** What was kept and why (becomes "="). */
  kept: string[];
  /** Formats that cannot be safely modified (becomes "!"). */
  warnings: string[];
}

/**
 * Removes from settings.json what the mod replaces: statusline tap (if mod remained installed) and
 * legacy permission hook (if permissions plugin remained installed). A single write, for a single backup.
 */
export function planMigration(settings: Settings, o: { modInstalled: boolean; permissionsInstalled: boolean; permissions: boolean }): MigrationPlan {
  const out: MigrationPlan = { done: [], kept: [], warnings: [] };
  let next = settings;
  const sl = rec(settings.statusLine);
  if (sl && isTapCommand(sl.command)) {
    if (!o.modInstalled) out.kept.push(tr("old statusline tap kept (the mod didn't get installed)"));
    else {
      const p = planTapUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('old statusline tap removed: the mod records usage in its place ({0})', [p.message]));
      } else if (p.action === 'skip') out.warnings.push(tr('old statusline tap: {0} (run npm run usage:uninstall after checking)', [p.message]));
    }
  }
  if (installedHook(next)) {
    if (!o.permissions) out.kept.push(tr('old permission hook kept (--sem-permissoes)'));
    else if (!o.permissionsInstalled) out.kept.push(tr("old permission hook kept (the permissions plugin didn't get installed)"));
    else {
      const p = planHookUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(tr('old permission hook removed: the {0} plugin answers in its place', [shortName(PERMISSIONS_PLUGIN)]));
      } else if (p.action === 'skip') out.warnings.push(tr('old permission hook: {0} (run npm run hooks:uninstall after checking)', [p.message]));
    }
  }
  if (next !== settings) out.settings = next;
  return out;
}

/** Differences between what should be installed and what Claude Code records after the steps. */
export function verifyInstall(after: AccountState, plugins: string[], version: string): string[] {
  const out: string[] = [];
  for (const id of plugins) {
    const p = userInstall(after, id);
    const name = shortName(id);
    if (!p) out.push(tr("{0}: doesn't show as installed in the Claude Code list", [name]));
    else if (!p.enabled) out.push(tr('{0}: installed, but disabled (claude plugin enable {1})', [name, id]));
    else if (p.version !== version) out.push(tr('{0}: Claude Code records version {1}, not {2} (does the manifest in mod/ have a different version?)', [name, p.version ?? '?', version]));
    if (p?.errors.length) out.push(`${name}: ${p.errors.join('; ')}`);
  }
  return out;
}

/**
 * For docker:up: updates only what is already installed, never installs. `hint` is the tip for accounts with
 * mod but without messages plugin (which came later): docker:up does not install it on its own.
 */
export type UpdatePlan =
  | { action: 'none'; installed: boolean; hint?: string }
  | { action: 'update'; steps: CliStep[]; hint?: string }
  | { action: 'warn'; message: string };

/** The messages plugin tip when account has mod but not messages. */
export const MESSAGES_HINT = tr('run npm run mod:install to send messages from the office (plugin {0})', [shortName(MESSAGES_PLUGIN)]);

export function planUpdate(state: AccountState, o: { root: string; version: string; sameDir?: (a: string, b: string) => boolean }): UpdatePlan {
  const same = o.sameDir ?? sameDir;
  // Legacy name: migration (remove codetown, install habblaud) belongs to mod:install; here only warning.
  // A warning counts as "installed", so clean install tip does not show for users already running mod.
  const legacy = legacySummary(state);
  if (legacy) return { action: 'warn', message: tr("still under the old name ({0}); docker:up doesn't switch it on its own: run npm run mod:install", [legacy]) };
  const installed = PLUGINS.map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
  if (!installed.length) return { action: 'none', installed: false };
  const hint = userInstall(state, MOD_PLUGIN) && !userInstall(state, MESSAGES_PLUGIN) ? { hint: MESSAGES_HINT } : {};
  const stale = installed.filter((p) => p.version !== o.version);
  if (!stale.length) return { action: 'none', installed: true, ...hint };
  // Marketplace from another folder (different clone, moved folder): updating from there would not bring this version.
  const m = state.marketplace;
  if (!m) return { action: 'warn', message: tr('the mod is installed, but the marketplace {0} is gone; run npm run mod:install', [MARKETPLACE]) };
  if (!m.path || !same(m.path, o.root)) {
    return { action: 'warn', message: tr("the mod comes from another folder ({0}), so it wasn't updated; to use this one: npm run mod:install", [m.path ?? m.source ?? '?']) };
  }
  return {
    action: 'update',
    steps: [
      { args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: tr('marketplace {0}: catalog reloaded', [MARKETPLACE]) },
      ...stale.map((p) => ({ args: ['plugin', 'update', p.id, '--scope', SCOPE], message: `${shortName(p.id)}: ${p.version ?? '?'} → ${o.version}`, plugin: p.id })),
    ],
    ...hint,
  };
}

/** Last useful lines of CLI output (to explain a failure). */
export function cliMessage(r: ClaudeResult): string {
  if (r.error) return r.error;
  const lines = stripAnsi(`${r.stdout}\n${r.stderr}`)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s✘✔✗✓×]+/, '').trim())
    .filter(Boolean);
  return lines.slice(-2).join(' · ') || tr('exited with code {0}', [r.code ?? '?']);
}

/** Status lines of an account (without header). */
export function describeStatus(state: AccountState, settings: Settings, o: { root: string; version: string; home: string; sameDir?: (a: string, b: string) => boolean }): string[] {
  const same = o.sameDir ?? sameDir;
  const lines: string[] = [];
  const m = state.marketplace;
  if (!m) lines.push(tr('marketplace {0}: not added', [MARKETPLACE]));
  else if (m.path && same(m.path, o.root)) lines.push(tr('marketplace {0}: this folder', [MARKETPLACE]));
  else lines.push(tr('marketplace {0}: another source ({1}); npm run mod:install points it to this folder', [MARKETPLACE, m.path ? tildify(m.path, o.home) : (m.source ?? '?')]));
  for (const id of PLUGINS) {
    const name = shortName(id);
    const all = state.plugins.filter((p) => p.id === id);
    if (!all.length) {
      lines.push(tr('{0}: not installed', [name]));
      continue;
    }
    for (const p of all) {
      const parts = [tr('installed{0}', [p.scope && p.scope !== SCOPE ? tr(' (scope {0})', [p.scope]) : '']), p.enabled ? tr('enabled') : tr('off')];
      parts.push(tr('version {0}{1}', [p.version ?? '?', p.version === o.version ? '' : tr(' (this folder: {0}; npm run mod:install or npm run docker:up updates it)', [o.version])]));
      if (p.folderVersion && p.folderVersion !== p.version) parts.push(tr('loads {0} from {1}', [p.folderVersion, tildify(p.readFromFolder ?? '?', o.home)]));
      if (p.errors.length) parts.push(`error: ${p.errors.join('; ')}`);
      lines.push(`${name}: ${parts.join(', ')}`);
    }
  }
  const legacy = legacySummary(state, (lm) => (lm.path && same(lm.path, o.root) ? tr('this folder') : lm.path ? tildify(lm.path, o.home) : (lm.source ?? '?')));
  if (legacy) lines.push(tr('! old name still registered: {0}; npm run mod:install replaces it with habblaud', [legacy]));
  const sl = rec(settings.statusLine);
  const hook = installedHook(settings);
  const modOn = !!userInstall(state, MOD_PLUGIN);
  const permOn = !!userInstall(state, PERMISSIONS_PLUGIN);
  if (sl && isTapCommand(sl.command)) {
    lines.push(
      modOn
        ? tr('! old statusline tap still installed alongside the mod: npm run mod:install removes it (or npm run usage:uninstall)')
        : tr('old statusline tap installed (old way; the mod replaces it)'),
    );
  }
  if (hook) {
    lines.push(
      permOn
        ? tr('! old permission hook still in settings.json alongside the plugin: both answer; npm run mod:install removes it (or npm run hooks:uninstall)')
        : tr('old permission hook installed (old way; the permissions plugin replaces it)'),
    );
  }
  if (settings.disableAllHooks === true) lines.push(tr("! disableAllHooks is on in this account's settings.json: no mod (or hook) runs"));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Effects (Claude Code CLI and settings.json)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** false with --sem-permissoes. */
  permissions: boolean;
  /** false with --sem-mensagens. */
  messages: boolean;
  /** --conta (empty = all detected). */
  accounts: string[];
  claudeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  /** Repo root (the marketplace). */
  root: string;
  /** package.json version. */
  version: string;
  claude: ClaudeRunner;
  out: (line: string) => void;
  /** Queries Habblaud /api/health during status (tests inject a mock). */
  health?: (port: number) => Promise<HealthInfo | undefined>;
}

/** What status uses from /api/health (`messages` exists from Habblaud with messages support). */
export interface HealthInfo {
  permissions?: boolean;
  messages?: boolean;
}

class FatalError extends Error {}

async function fetchHealth(port: number): Promise<HealthInfo | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as HealthInfo;
  } catch {
    return undefined;
  }
}

/** Habblaud port (HABBLAUD_PORT or default). */
function habblaudPort(env: NodeJS.ProcessEnv): number {
  const p = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_PORT;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let permissions = true;
  let messages = true;
  let claudeCmd: string | undefined;
  const accounts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--sem-permissoes') permissions = false;
    else if (a === '--sem-mensagens') messages = false;
    else if (a === '--conta') {
      const dir = argv[++i];
      if (!dir) throw new FatalError(tr('--conta needs the account folder (e.g. --conta ~/.claude-conta2).'));
      accounts.push(dir);
    } else if (a === '--claude') {
      claudeCmd = argv[++i];
      if (!claudeCmd) throw new FatalError(tr('--claude needs a command or path.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('specify what to do: install, uninstall or status.\n\n{0}', [USAGE]));
  return { command, dryRun, permissions, messages, accounts, claudeCmd };
}

/** Root package.json version. */
export function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) throw new FatalError(tr('package.json without "version" in {0}', [root]));
  return pkg.version;
}

/** Marketplace and plugins for an account, via CLI (or reason for failure). */
export function readAccountState(claude: ClaudeRunner, env: NodeJS.ProcessEnv): AccountState | { error: string } {
  const mr = claude(['plugin', 'marketplace', 'list', '--json'], env);
  if (mr.error || mr.code !== 0) return { error: tr("couldn't list the marketplaces ({0})", [cliMessage(mr)]) };
  const markets = parseMarketplaceList(mr.stdout);
  if (!markets) return { error: tr("couldn't parse Claude Code's marketplace list") };
  const pr = claude(['plugin', 'list', '--json'], env);
  if (pr.error || pr.code !== 0) return { error: tr("couldn't list the plugins ({0})", [cliMessage(pr)]) };
  const plugins = parsePluginList(pr.stdout);
  if (!plugins) return { error: tr("couldn't parse Claude Code's plugin list") };
  return { marketplace: markets.find((m) => m.name === MARKETPLACE), legacyMarketplace: markets.find((m) => m.name === LEGACY_MARKETPLACE), plugins };
}

/** Account directories: those from --conta (must exist) or detected. */
function accountDirs(opts: RunOptions, env: NodeJS.ProcessEnv, home: string): string[] {
  if (!opts.accounts.length) return discoverClaudeDirs(env, home);
  return [...new Set(opts.accounts.map((a) => expandHome(a, home)))].map((dir) => {
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new FatalError(tr('--conta {0}: folder not found.', [dir]));
    return dir;
  });
}

/** Last captured usage (via mod or tap) of an account, for status. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string, now: Date): string {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Rec;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    return tr('last usage captured {0} ago ({1})', [formatAge(now.getTime() - at), j.source === 'mod' ? tr('via the mod') : tr('via the statusline tap')]);
  } catch {
    return tr('no usage captured yet (it arrives after the next reply in an open session of this account)');
  }
}

/** Runs command for all accounts. Returns exit code. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = accountDirs(opts, env, home);
  if (!dirs.length) {
    out(tr('No Claude Code account found (~/.claude* with projects/ or sessions/). Use --conta <folder> or HABBLAUD_CLAUDE_DIRS.'));
    return 1;
  }
  const manifest = join(ctx.root, '.claude-plugin', 'marketplace.json');
  if (opts.command === 'install' && !existsSync(manifest)) {
    out(tr("{0} not found: this folder doesn't have the mod (old Habblaud version? run git pull).", [tildify(manifest, home)]));
    return 1;
  }

  // Single version: all accounts use same executable, only CLAUDE_CONFIG_DIR varies.
  const vr = ctx.claude(['--version'], env);
  if (vr.error) {
    out(tr("Couldn't run Claude Code: {0}.", [vr.error]));
    out(tr('Install Claude Code (https://code.claude.com) or say where it is: npm run mod:<command> -- --claude <path>'));
    return 1;
  }
  const cliVersion = parseVersion(vr.stdout) ? parseVersion(vr.stdout)!.join('.') : undefined;
  if (opts.command === 'install') {
    if (!cliVersion) out(tr('! Couldn\'t parse the Claude Code version ("{0}"); continuing anyway.', [cliMessage(vr)]));
    else if (!versionAtLeast(cliVersion, MIN_CLAUDE_VERSION)) {
      out(tr('The mod requires Claude Code {0} or newer, and this one is {1}.', [MIN_CLAUDE_VERSION, cliVersion]));
      out(tr('Update Claude Code (claude update) and run again. Or use the old way, which works on earlier versions:'));
      out(tr('  npm run usage:install    # live 5h/weekly usage (statusline tap)'));
      out(tr('  npm run hooks:install    # answer permission requests from the office'));
      return 1;
    }
  }
  if (opts.command === 'status') {
    out(tr('Claude Code {0}{1} · Habblaud {2} in {3}', [cliVersion ?? tr('(unknown version)'), cliVersion && !versionAtLeast(cliVersion, MIN_CLAUDE_VERSION) ? tr(' — the mod requires {0}+', [MIN_CLAUDE_VERSION]) : '', ctx.version, tildify(ctx.root, home)]));
  }

  // Legacy name: ~/.codetown becomes ~/.habblaud before creating (or using) usage folder.
  if (opts.command === 'install') {
    const moved = migrateLegacyState(home, opts.dryRun);
    if (moved) out(moved);
  }
  // The mod saves usage in ~/.habblaud/usage, but doesn't create folder (docker:up also mounts it).
  if (opts.command === 'install' && !opts.dryRun) {
    const usageDir = usageDirOf(env, home);
    try {
      if (!existsSync(usageDir)) {
        mkdirSync(usageDir, { recursive: true, mode: 0o700 });
        out(tr('✓ usage folder created: {0}', [tildify(usageDir, home)]));
      }
    } catch (err) {
      out(tr("! couldn't create {0} ({1}); live usage won't be recorded", [tildify(usageDir, home), (err as Error).message]));
    }
  }

  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const label = `${basename(dir)} (${tildify(dir, home)})`;
    const cenv = accountEnv(env, dir, home);
    const state = readAccountState(ctx.claude, cenv);
    const file = join(dir, 'settings.json');
    if (opts.command === 'status') {
      out(`• ${label}`);
      const read = readSettings(file);
      const settings = 'error' in read ? {} : read.settings;
      if ('error' in read) out(tr('    ✗ settings.json: {0}', [read.error]));
      if ('error' in state) {
        out(`    ✗ ${state.error}`);
        failures++;
      } else for (const l of describeStatus(state, settings, { root: ctx.root, version: ctx.version, home })) out(`    ${l}`);
      out(`    ${lastCapture(dir, env, home, ctx.now)}`);
      continue;
    }

    out(`${label}:`);
    if ('error' in state) {
      out(`  ✗ ${state.error}`);
      failures++;
      continue;
    }
    const plan =
      opts.command === 'install' ? planInstall(state, { root: ctx.root, version: ctx.version, permissions: opts.permissions, messages: opts.messages }) : planUninstall(state);
    const failed = new Set<string>();
    let broken = false;
    let stepFailed = false;
    for (const item of plan.items) {
      if (!('args' in item)) {
        out(`  = ${item.unchanged}`);
        continue;
      }
      if (opts.dryRun) {
        out(tr('  ~ {0} (dry run: claude {1})', [item.message, item.args.join(' ')]));
        continue;
      }
      // On install, after a failure subsequent steps for this account do not run (no marketplace = no
      // plugin), except after a legacy name plugin that failed to uninstall (its marketplace removes it). On
      // removal, keep going: remove whatever can be removed.
      if (broken && opts.command === 'install') {
        if (item.plugin) failed.add(item.plugin);
        continue;
      }
      const r = ctx.claude(item.args, cenv);
      if (!r.error && r.code === 0) {
        out(`  ✓ ${item.message}`);
        changed++;
      } else {
        out(tr('  ✗ {0}: failed ({1})', [item.message.split(':')[0], cliMessage(r)]));
        if (item.plugin) failed.add(item.plugin);
        stepFailed = true;
        if (!item.keepGoing) broken = true;
      }
    }
    if (stepFailed) failures++;
    for (const n of plan.notes) out(`  ! ${n}`);
    if (opts.command !== 'install') continue;

    // Verify with Claude Code what remained installed (a no-op update exits with 0) and decide
    // migration based on that. In dry-run (or if list fails), plan minus failures applies.
    let ok = (id: string) => plan.plugins.includes(id) && !failed.has(id);
    if (!opts.dryRun) {
      const after = readAccountState(ctx.claude, cenv);
      if (!('error' in after)) {
        for (const w of verifyInstall(after, plan.plugins, ctx.version)) out(`  ! ${w}`);
        const legacy = legacySummary(after);
        if (legacy) out(tr('  ! old name still registered: {0}; run npm run mod:install again (or check with npm run mod:status)', [legacy]));
        ok = (id: string) => userInstall(after, id)?.enabled === true;
      }
    }

    // Migration: read settings.json AFTER CLI (it also writes there: enabledPlugins, marketplaces).
    const read = readSettings(file);
    if ('error' in read) {
      out(tr("  ✗ settings.json: {0}; the old tap and hook weren't checked", [read.error]));
      failures++;
      continue;
    }
    const mig = planMigration(read.settings, { modInstalled: ok(MOD_PLUGIN), permissionsInstalled: ok(PERMISSIONS_PLUGIN), permissions: opts.permissions });
    for (const k of mig.kept) out(`  = ${k}`);
    for (const w of mig.warnings) out(`  ! ${w}`);
    if (read.settings.disableAllHooks === true) out(tr("  ! disableAllHooks is on in this account's settings.json: the mod won't run until you turn it off"));
    if (!mig.settings) continue;
    if (opts.dryRun) {
      for (const d of mig.done) out(tr('  ~ {0} (dry run: nothing written)', [d]));
      continue;
    }
    try {
      const backup = writeSettings(file, mig.settings, read.raw, ctx.now);
      for (const d of mig.done) out(`  ✓ ${d}`);
      if (backup) out(tr('    settings.json backup in {0}', [tildify(backup, home)]));
      changed++;
    } catch (err) {
      out(tr("  ✗ couldn't write settings.json ({0}); the old tap and hook remain", [(err as Error).message]));
      failures++;
    }
  }

  if (opts.command === 'install' && !opts.dryRun && !failures) {
    out('');
    out(tr('Done. New Claude Code sessions already load the mod; in sessions already open, run /reload-plugins (or'));
    out(tr("reopen the session). The 5h/weekly usage reaches Habblaud after each session's next reply."));
    out(tr('To check: npm run mod:status · To undo: npm run mod:uninstall'));
  }
  if (opts.command === 'uninstall' && !opts.dryRun && changed) {
    out('');
    out(tr('Done. Sessions already open keep the mod until /reload-plugins (or until the session is reopened).'));
    out(tr('To go back to the old way (Claude Code before 2.1.287): npm run usage:install and npm run hooks:install'));
  }
  if (opts.command === 'status') {
    // Mod and plugins only speak with local Habblaud: check if it is there to answer.
    const port = habblaudPort(env);
    const health = await (ctx.health ?? fetchHealth)(port);
    const at = tr('Habblaud at http://127.0.0.1:{0}', [port]);
    if (!health) out(tr('{0}: down (the mod keeps recording usage; permission requests stay in the terminal only).', [at]));
    else if (health.permissions) out(tr('{0}: up and handling permission requests (with a page open).', [at]));
    else out(tr('{0}: up, but answering from the office is off (port exposed on the network or HABBLAUD_TERMINAL=0).', [at]));
    // A Habblaud prior to messages says nothing about them.
    if (health && typeof health.messages === 'boolean') {
      out(
        health.messages
          ? tr('Messages from the office: on (they reach open sessions with the {0} plugin).', [shortName(MESSAGES_PLUGIN)])
          : tr('Messages from the office: off in Habblaud (port exposed on the network, HABBLAUD_TERMINAL=0 or HABBLAUD_MENSAGENS=0).'),
      );
    }
  }
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// For docker:up: updates mod for existing installs
// ---------------------------------------------------------------------------------------------

export interface ModUpdateContext {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
  version: string;
  claude: ClaudeRunner;
}

export interface ModUpdateResult {
  /** Some account has mod (or another plugin) installed, even under legacy name. */
  installed: boolean;
  /** Could not query Claude Code on any account (e.g. `claude` not in PATH). */
  unavailable: boolean;
  lines: Array<{ level: 'info' | 'warn'; text: string }>;
}

/**
 * For each account with mod installed at a version different from package.json: reloads catalog and updates
 * installed plugins. With legacy name remnants, only warns (switch belongs to mod:install). With mod and
 * without messages plugin, hints to run mod:install. Never installs and never throws: any failure becomes a warning.
 */
export function updateInstalledMods(accounts: Array<{ dir: string; label: string }>, ctx: ModUpdateContext): ModUpdateResult {
  const res: ModUpdateResult = { installed: false, unavailable: false, lines: [] };
  if (!accounts.length) return res;
  // Runner that never throws: any exception becomes a normal failure (docker:up cannot crash because of this).
  const claude: ClaudeRunner = (args, env) => {
    try {
      return ctx.claude(args, env);
    } catch (err) {
      return { code: null, stdout: '', stderr: '', error: (err as Error).message };
    }
  };
  // Without CLI, same failure would repeat across all accounts: probe once and warn once.
  const probe = claude(['--version'], ctx.env);
  if (probe.error || probe.code !== 0) {
    res.unavailable = true;
    res.lines.push({ level: 'warn', text: tr("couldn't query Claude Code ({0}); the mod wasn't checked.", [cliMessage(probe)]) });
    return res;
  }
  for (const { dir, label } of accounts) {
    const env = accountEnv(ctx.env, dir, ctx.home);
    const state = readAccountState(claude, env);
    if ('error' in state) {
      res.lines.push({ level: 'warn', text: tr('mod on {0}: {1}', [label, state.error]) });
      continue;
    }
    const plan = planUpdate(state, { root: ctx.root, version: ctx.version });
    if (plan.action !== 'none' || plan.installed) res.installed = true;
    if (plan.action === 'warn') {
      res.lines.push({ level: 'warn', text: tr('mod on {0}: {1}', [label, plan.message]) });
      continue;
    }
    if (plan.action === 'update') res.lines.push(applyUpdate(plan.steps, { claude, env, version: ctx.version, label }));
    // Has mod and not messages plugin (which came later): docker:up does not install on its own, only hints.
    if (plan.hint) res.lines.push({ level: 'info', text: tr('Tip for {0}: {1}', [label, plan.hint]) });
  }
  return res;
}

/** Runs update steps for an account and reports outcome in a single line. */
function applyUpdate(steps: CliStep[], o: { claude: ClaudeRunner; env: NodeJS.ProcessEnv; version: string; label: string }): ModUpdateResult['lines'][number] {
  for (const step of steps) {
    const r = o.claude(step.args, o.env);
    if (r.error || r.code !== 0) {
      return { level: 'warn', text: tr("couldn't update the mod on {0}: {1} ({2}). Try: npm run mod:install", [o.label, step.message.split(':')[0], cliMessage(r)]) };
    }
  }
  // Only report "updated" if Claude Code actually registered the new version.
  const after = readAccountState(o.claude, o.env);
  const ids = steps.flatMap((s) => (s.plugin ? [s.plugin] : []));
  const issues = 'error' in after ? [after.error] : verifyInstall(after, ids, o.version);
  if (issues.length) return { level: 'warn', text: tr('mod on {0}: {1}', [o.label, issues.join('; ')]) };
  return { level: 'info', text: tr('Mod updated to {0} on {1}; open sessions: /reload-plugins', [o.version, o.label]) };
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
    root: ROOT,
    version: readPackageVersion(ROOT),
    claude: makeClaudeRunner(parsed.claudeCmd),
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[mod] Error: {0}', [err.message]) : tr('[mod] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
