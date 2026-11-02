// Codex accounts: one CODEX_HOME directory per account (~/.codex, ~/.codex-work...). Pure Node and no server
// dependencies: also imported by scripts/docker-up.ts (via tsx) on the host.
//
// Discovery: HABBLAUD_CODEX_DIRS (comma-separated list) overrides everything; otherwise CODEX_HOME and `$HOME/.codex*`
// that look like a Codex directory (isCodexHome). Account letter: shell alias `alias x='CODEX_HOME=... codex'`
// (without CODEX_HOME = the default directory); without alias, a derived letter that does not collide with Claude Code.
// Color: from account palette, avoiding Claude Code colors. Name: "Codex" (or "Codex X" with multiple accounts).
// The plan comes later, from session files (rate_limits.plan_type).
//
// Privacy: NEVER reads `auth.json` or `config.toml` (only checks if they exist, in isCodexHome); from shell files,
// only `alias X='... codex ...'` lines. In Docker the host sends everything ready in HABBLAUD_ACCOUNTS (`provider:
// 'codex'`, with the host `configDir`: that is where `codex queue` runs).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  isCodexHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Default Codex directory: CODEX_HOME or $HOME/.codex. */
export function defaultCodexHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.CODEX_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.codex');
}

/**
 * Observed Codex directories. HABBLAUD_CODEX_DIRS (comma-separated list) overrides detection and is used
 * as-provided (only needs to exist: a newly created account has no sessions yet). Otherwise: CODEX_HOME and
 * `$HOME/.codex*` that pass isCodexHome. Stable order: default first, then alphabetical.
 */
export function discoverCodexDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_CODEX_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultCodexHome(env, home);
  if (isCodexHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.codex')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isCodexHome(p)) found.push(p);
    }
  } catch {
    // $HOME unreadable (e.g. container without home)
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Codex account overrides in HABBLAUD_ACCOUNTS (from the host, in Docker). */
export function codexOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'codex');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Candidate letters for account without alias: suffix initial (".codex-work" → W), X, Y, Z... and the alphabet. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?codex[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('X', 'Y', 'Z', 'W', 'V', 'U');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface CodexDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letters and colors already used by Claude Code accounts (will not repeat). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * One account per Codex directory, IN THE SAME ORDER as `dirs`. `configDir` is the path for display and for
 * `codex queue` (in Docker, the host path from HABBLAUD_ACCOUNTS). No email (not available without reading credentials)
 * and no plan (comes from session files).
 */
export function detectCodexAccounts(dirs: string[], opts: CodexDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = codexOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'codex'), home, defaultCodexHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    const acc: DetectedAccount = {
      id: p.id,
      provider: 'codex',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Codex ${short}` : 'Codex'),
      color,
    };
    const plan = str(p.ov?.plan);
    if (plan) acc.plan = plan;
    return acc;
  });
}

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
};

/** Codex `rate_limits.plan_type` ("plus", "pro", "self_serve_business_usage_based"...) for display. */
export function codexPlanLabel(raw: unknown): string | undefined {
  const v = str(raw)?.toLowerCase();
  if (!v || v === 'unknown') return undefined;
  if (PLAN_NAMES[v]) return PLAN_NAMES[v];
  return v
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 40);
}
