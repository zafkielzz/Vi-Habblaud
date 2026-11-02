// Detection of Claude Code accounts (one config dir per account) and their metadata.
// Pure Node without dependencies: also imported by scripts/docker-up.ts (via tsx) on the host.
// A Codex directory (CODEX_HOME, e.g.: ~/.codex) also has `sessions/` and is excluded (isCodexHome): Codex
// accounts are discovered by the Codex source and enter AccountsService with `provider: 'codex'`.
//
// Privacy: from .claude.json we read ONLY the account profile email and organization
// (oauthAccount.{emailAddress, organizationName}) and the usage cache (cachedUsageUtilization);
// from shell files, ONLY the lines `alias X='... claude ...'` (and `alias X='... codex ...'`, for
// Codex accounts: see sources/codex/accounts.ts). Credentials are never read and none of this is logged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Provider } from '../../shared/types';
import { tr } from '../../shared/i18n';

export interface DetectedAccount {
  id: string;
  /** Account tool; absent = 'claude' (detectAccounts only returns Claude Code accounts). */
  provider?: Provider;
  configDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: unknown;
}

/** Fixed, distinct palette assigned in the stable account order. */
export const ACCOUNT_COLORS = ['#f08a3c', '#4aa8e8', '#5cc97b', '#a77bf3', '#f06fa0'] as const;

const RC_FILES = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile'];

/** Override from HABBLAUD_ACCOUNTS (the host passes pre-built metadata to the container). */
export interface AccountOverride {
  id?: string;
  /** Account tool; absent = 'claude'. Codex accounts are excluded from Claude Code account discovery. */
  provider?: Provider;
  configDir?: string;
  mountDir?: string;
  short?: string;
  name?: string;
  email?: string;
  organization?: string;
  plan?: string;
  color?: string;
  cachedUsage?: unknown;
}

export interface ClaudeAlias {
  /** Alias name as typed in the shell (e.g., "d"). */
  name: string;
  /**
   * Absolute path of the alias variable (CLAUDE_CONFIG_DIR; in Codex, CODEX_HOME); absent = default account
   * ($HOME/.claude; in Codex, its default directory).
   */
  configDir?: string;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expands `~`, `$HOME`, and `${HOME}` and returns the absolute path without a trailing slash. */
export function expandHome(p: string, home: string): string {
  const expanded = p
    .trim()
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
  const abs = resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Year folder (AAAA) inside sessions/: Codex stores rollouts in sessions/AAAA/MM/DD/. */
const YEAR_DIR = /^\d{4}$/;

/**
 * Is the directory from Codex (a CODEX_HOME, e.g.: ~/.codex)? It also has `sessions/`; without this check it would
 * become an empty Claude Code account and the watcher would read `sessions/` as the session registry. Only marks
 * that Claude Code never writes, checked by EXISTENCE (nothing is opened, neither `auth.json` nor `config.toml`):
 * - `sessions/AAAA/` (rollouts by date; Claude Code stores `sessions/<pid>.json` directly there);
 * - `thread-writer-locks/` or `archived_sessions/`;
 * - `config.toml` or `auth.json`.
 * With `projects/` (which Codex does not create) it is always Claude Code: no previously working account
 * becomes invalid. Non-existent or empty directories are not Codex.
 */
export function isCodexHome(p: string): boolean {
  if (isDir(join(p, 'projects'))) return false;
  if (isDir(join(p, 'thread-writer-locks')) || isDir(join(p, 'archived_sessions'))) return true;
  if (isFile(join(p, 'config.toml')) || isFile(join(p, 'auth.json'))) return true;
  try {
    return readdirSync(join(p, 'sessions'), { withFileTypes: true }).some((e) => e.isDirectory() && YEAR_DIR.test(e.name));
  } catch {
    return false;
  }
}

/** Looks like a Claude Code config dir (`projects/` or `sessions/`), without checking if it is Codex. */
function hasClaudeLayout(p: string): boolean {
  return isDir(join(p, 'projects')) || isDir(join(p, 'sessions'));
}

/** Claude Code config dir: `projects/` or `sessions/`, and is not a Codex directory. */
export function isClaudeDir(p: string): boolean {
  return hasClaudeLayout(p) && !isCodexHome(p);
}

export function isDefaultDir(dir: string, home: string): boolean {
  return resolve(dir) === resolve(home, '.claude');
}

export function parseAccountOverrides(raw: string | undefined): AccountOverride[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is AccountOverride => !!o && typeof o === 'object' && !Array.isArray(o));
  } catch {
    return [];
  }
}

/** Claude Code account overrides (without `provider` or with 'claude'); Codex overrides stay with its source. */
function claudeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === undefined || o.provider === 'claude');
}

/**
 * Watched config dirs. HABBLAUD_CLAUDE_DIRS (comma-separated list) overrides everything;
 * otherwise: `$HOME/.claude*` directories with `projects/` or `sessions/`, plus CLAUDE_CONFIG_DIR
 * (also accepts a list) and existing `mountDir` entries from HABBLAUD_ACCOUNTS.
 * In all paths, Codex directories are excluded (isCodexHome; see codexDirsRefused).
 * Stable order: default account first, then alphabetical.
 */
export function discoverClaudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).dirs;
}

/**
 * Directories found by Claude Code account discovery (or received from HABBLAUD_CLAUDE_DIRS,
 * CLAUDE_CONFIG_DIR, or HABBLAUD_ACCOUNTS) and rejected because they belong to Codex: to warn whoever listed them.
 */
export function codexDirsRefused(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  return scanClaudeDirs(env, home).codex;
}

function scanClaudeDirs(env: NodeJS.ProcessEnv, home: string): { dirs: string[]; codex: string[] } {
  const codex: string[] = [];
  /** Excluded if from Codex (recorded in `codex`). */
  const notCodex = (p: string) => {
    if (!isCodexHome(p)) return true;
    codex.push(p);
    return false;
  };
  const unique = (list: string[]) => [...new Set(list)];

  const override = splitList(env.HABBLAUD_CLAUDE_DIRS);
  if (override.length) {
    const dirs = unique(override.map((p) => expandHome(p, home)));
    return { dirs: dirs.filter(notCodex), codex };
  }

  const found: string[] = [];
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.claude')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (hasClaudeLayout(p) && notCodex(p)) found.push(p);
    }
  } catch {
    // Unreadable $HOME (e.g.: container without home): continue with other sources
  }
  for (const p of splitList(env.CLAUDE_CONFIG_DIR)) {
    const abs = expandHome(p, home);
    if (isDir(abs) && notCodex(abs)) found.push(abs);
  }
  for (const o of claudeOverrides(env.HABBLAUD_ACCOUNTS)) {
    if (typeof o.mountDir !== 'string') continue;
    if (hasClaudeLayout(o.mountDir) && notCodex(o.mountDir)) found.push(expandHome(o.mountDir, home));
  }
  const dirs = unique(found.map((p) => expandHome(p, home)));
  dirs.sort((a, b) => {
    const da = isDefaultDir(a, home) ? 0 : 1;
    const db = isDefaultDir(b, home) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return { dirs, codex: unique(codex.map((p) => expandHome(p, home))) };
}

const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)=(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*(?:#.*)?$/;
/** Identifies the alias of each tool: the invoked command and the variable with the account directory. */
/** Tools with accounts via shell aliases (Antigravity uses profiles: sources/agy/profiles.ts). */
type AliasTool = 'claude' | 'codex';
const ALIAS_TOOLS: Record<AliasTool, { invokes: RegExp; dir: RegExp }> = {
  claude: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?claude(?=$|[\s;&|)])/,
    dir: /\bCLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
  codex: {
    invokes: /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?codex(?=$|[\s;&|)])/,
    dir: /\bCODEX_HOME=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/,
  },
};

/**
 * Extracts shell aliases invoking the tool (`claude` or `codex`), with the account directory (CLAUDE_CONFIG_DIR
 * or CODEX_HOME). Considers ONLY `alias NAME='...'` lines (or with double quotes); any other line is ignored.
 */
export function parseToolAliases(text: string, home: string, tool: AliasTool): ClaudeAlias[] {
  const { invokes, dir: dirRe } = ALIAS_TOOLS[tool];
  const out: ClaudeAlias[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ALIAS_RE.exec(line);
    if (!m) continue;
    const body = m[2] ?? m[3]?.replace(/\\(.)/g, '$1') ?? '';
    if (!invokes.test(body)) continue;
    const dir = dirRe.exec(body);
    const raw = dir ? (dir[1] ?? dir[2] ?? dir[3]) : undefined;
    out.push(raw ? { name: m[1], configDir: expandHome(raw, home) } : { name: m[1] });
  }
  return out;
}

/** Shell aliases that invoke `claude` (see parseToolAliases). */
export function parseClaudeAliases(text: string, home: string): ClaudeAlias[] {
  return parseToolAliases(text, home, 'claude');
}

/** Reads tool aliases (default: `claude`) from the user's shell startup files. */
export function readShellAliases(home: string, tool: AliasTool = 'claude'): ClaudeAlias[] {
  const out: ClaudeAlias[] = [];
  for (const f of RC_FILES) {
    try {
      out.push(...parseToolAliases(readFileSync(join(home, f), 'utf8'), home, tool));
    } catch {
      // missing or unreadable file
    }
  }
  return out;
}

/**
 * Chooses the shortcut for each account: the shortest alias (up to 3 characters); tie = first declared. An alias
 * without a directory belongs to the default account (`defaultDir`; default $HOME/.claude).
 */
export function shortcutsByDir(aliases: ClaudeAlias[], home: string, defaultDir: string = resolve(home, '.claude')): Map<string, string> {
  const best = new Map<string, string>();
  for (const a of aliases) {
    if (a.name.length > 3) continue;
    const dir = a.configDir ?? defaultDir;
    const cur = best.get(dir);
    if (cur === undefined || a.name.length < cur.length) best.set(dir, a.name);
  }
  return new Map([...best].map(([dir, name]) => [dir, name.toUpperCase()]));
}

interface GlobalConfigInfo {
  email?: string;
  organization?: string;
  cachedUsage?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Organization name worth displaying. Personal accounts receive an automatically generated name
 * ("<e-mail>'s Organization"), which is meaningless: it is excluded.
 */
export function meaningfulOrganization(organization: string | undefined, email: string | undefined): string | undefined {
  if (!organization) return undefined;
  const generic = /^(.+?)['’]s organi[sz]ation$/i.exec(organization.trim());
  if (generic && (!email || generic[1].trim().toLowerCase() === email.trim().toLowerCase() || generic[1].includes('@'))) return undefined;
  return organization;
}

/**
 * Reads from Claude Code's global config ($HOME/.claude.json for the default account, <dir>/.claude.json
 * for others) only the account identification and usage cache.
 */
export function readGlobalConfig(dir: string, home: string): GlobalConfigInfo {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  let fallback: GlobalConfigInfo | undefined;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const profile = j.oauthAccount && typeof j.oauthAccount === 'object' ? (j.oauthAccount as Record<string, unknown>) : undefined;
      const cache = j.cachedUsageUtilization && typeof j.cachedUsageUtilization === 'object' ? j.cachedUsageUtilization : undefined;
      const email = str(profile?.emailAddress);
      const info: GlobalConfigInfo = {
        email,
        organization: meaningfulOrganization(str(profile?.organizationName), email),
        cachedUsage: cache,
      };
      if (profile) return info;
      fallback ??= info;
    } catch {
      // Invalid JSON (being written?): try next candidate
    }
  }
  return fallback ?? {};
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return (
    overrides.find((o) => o.id === id) ??
    overrides.find((o) => norm(o.mountDir) === dir) ??
    overrides.find((o) => norm(o.configDir) === dir)
  );
}

/** Account IDs (basename of dir), disambiguated if two dirs have the same name. */
export function accountIds(dirs: string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = basename(d) || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * One account per config dir, IN THE SAME ORDER as `dirs`.
 * `configDir` is the path for display (in Docker, the host path from HABBLAUD_ACCOUNTS).
 */
export function detectAccounts(dirs: string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = claudeOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home), home);
  const ids = accountIds(dirs);

  const partial = dirs.map((dir, i) => {
    const id = ids[i];
    const ov = matchOverride(overrides, id, resolve(dir), home);
    const cfg = readGlobalConfig(dir, home);
    return { dir, id, ov, cfg, short: str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir)) };
  });

  // Accounts without a detected shortcut receive A, B, C... (without colliding with already used shortcuts).
  const used = new Set(partial.map((p) => p.short).filter((s): s is string => !!s));
  let next = 0;
  const fallbackShort = () => {
    for (; next < 26; next++) {
      const letter = String.fromCharCode(65 + next);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
    return '?';
  };

  return partial.map((p, i) => {
    const short = p.short ?? fallbackShort();
    const email = str(p.ov?.email) ?? p.cfg.email;
    // Named like the Antigravity workers ("name (Agy)"): the part of the e-mail before @, else "Account A".
    const user = email?.split('@')[0].trim();
    const acc: DetectedAccount = {
      id: p.id,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (user ? `${user} (Claude)` : tr('Account {0}', [short])),
      color: str(p.ov?.color) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
    };
    const organization = meaningfulOrganization(str(p.ov?.organization) ?? p.cfg.organization, email);
    const plan = str(p.ov?.plan);
    const cachedUsage = p.ov?.cachedUsage ?? p.cfg.cachedUsage;
    if (email) acc.email = email;
    if (organization) acc.organization = organization;
    if (plan) acc.plan = plan;
    if (cachedUsage !== undefined) acc.cachedUsage = cachedUsage;
    return acc;
  });
}
