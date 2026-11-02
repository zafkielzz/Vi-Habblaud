// Antigravity CLI (`agy`) accounts: an isolated profile per account in ~/.agy_profiles/accN (the HOME that
// `agy-as accN` uses), with agy state in <profile>/.gemini/antigravity-cli. Each one is an account; the ones registered
// in the team (server/team.ts) are the workers in the office.
//
// Character name: from ~/.agy_profiles/names.conf ("acc2 Huy"), else the account's e-mail username
// ("alice@gmail.com" -> "alice"; up to the first dot), else the account ("acc2").
// E-mail: from the most recent "OAuth: ..." line in agy's cli.log (for name and label only; no credentials).
// Default role: ~/.agy_profiles/roles.conf ("acc2 impl accept-edits"), matching `agy-sync`; only shown while the
// worker is active, when the prompt (agy-ask --role) doesn't specify another.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';

/** Profile root: HABBLAUD_AGY_PROFILES or ~/.agy_profiles. */
export function agyProfilesRoot(env: NodeJS.ProcessEnv, home: string): string {
  return env.HABBLAUD_AGY_PROFILES?.trim() || join(home, '.agy_profiles');
}

export interface AgyProfile {
  /** Account name ("acc2"): the profile directory and what follows `agy-as`. */
  acc: string;
  /** Profile directory (the HOME for this account's agy). */
  home: string;
  /** agy state for the account (<profile>/.gemini/antigravity-cli). */
  stateDir: string;
  role?: string;
  email?: string;
  /** Name chosen in names.conf. */
  name?: string;
}

/** `names.conf`: "account character-name" per line (name may contain spaces), `#` for comments. */
export function parseNamesConf(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(raw.replace(/#.*/, ''));
    if (m) names.set(m[1], m[2]);
  }
  return names;
}

/** Role of a vacant account (e.g. no quota left): "acc3 off" in roles.conf; not a worker of a brand-new team. */
export const AGY_OFF_ROLE = 'off';

/** `roles.conf`: "account role mode" per line, `#` for comments. */
export function parseRolesConf(text: string): Map<string, string> {
  const roles = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [acc, role] = line.split(/\s+/);
    if (acc && role) roles.set(acc, role);
  }
  return roles;
}

/** Account e-mail from the last "server_oauth ... OAuth: ..." line in cli.log (reads only end of file). */
export function emailFromCliLog(text: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('server_oauth') || !line.includes('OAuth:')) continue;
    const m = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/.exec(line);
    if (m) found = m[0];
  }
  return found;
}

function readTail(path: string, max = 256 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Account e-mail from the agy logs. `cli.log` links to the newest run's log, which may not have the OAuth line yet (a
 * run that just started), so older runs in log/ are tried too, newest first (the line sits near the start of each).
 */
export function emailFromLogs(stateDir: string, maxFiles = 20): string | undefined {
  const first = emailFromCliLog(readTail(join(stateDir, 'cli.log')));
  if (first) return first;
  let logs: string[];
  try {
    logs = readdirSync(join(stateDir, 'log')).filter((n) => /^cli-.*\.log$/.test(n));
  } catch {
    return undefined;
  }
  for (const name of logs.sort().reverse().slice(0, maxFiles)) {
    const email = emailFromCliLog(readHead(join(stateDir, 'log', name)));
    if (email) return email;
  }
  return undefined;
}

function readHead(path: string, max = 256 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.alloc(Math.min(fstatSync(fd).size, max));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Profiles with agy state, in natural order (acc1, acc2, ..., acc10). */
export function discoverAgyProfiles(root: string): AgyProfile[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  let roles = new Map<string, string>();
  let custom = new Map<string, string>();
  try {
    roles = parseRolesConf(readFileSync(join(root, 'roles.conf'), 'utf8'));
  } catch {
    // no roles.conf: workers without default role
  }
  try {
    custom = parseNamesConf(readFileSync(join(root, 'names.conf'), 'utf8'));
  } catch {
    // no names.conf: name from e-mail
  }
  return names
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && isDir(join(root, n, '.gemini', 'antigravity-cli')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((acc) => {
      const home = join(root, acc);
      const stateDir = join(home, '.gemini', 'antigravity-cli');
      const p: AgyProfile = { acc, home, stateDir };
      const role = roles.get(acc);
      if (role) p.role = role;
      const email = emailFromLogs(stateDir);
      if (email) p.email = email;
      const name = custom.get(acc);
      if (name) p.name = name;
      return p;
    });
}

/** Worker name: names.conf, else the e-mail user (up to the first dot), else the account. */
export function workerName(p: Pick<AgyProfile, 'acc' | 'email' | 'name'>): string {
  return p.name || p.email?.split('@')[0].split('.')[0] || p.acc;
}

/** Name shown for the character and the account card: "alice (Agy)". */
export function workerLabel(p: Pick<AgyProfile, 'acc' | 'email' | 'name'>): string {
  return `${workerName(p)} (Agy)`;
}

/**
 * Account metadata for AccountsService. Letter: the account number ("acc2" -> "2"), else the first letter; color:
 * from the account palette, after existing ones (Claude Code and Codex), wrapping around if needed.
 */
export function agyDetected(p: AgyProfile, index: number, takenColors: readonly string[]): DetectedAccount {
  const free = ACCOUNT_COLORS.filter((c) => !takenColors.includes(c));
  const palette = free.length ? free : ACCOUNT_COLORS;
  const d: DetectedAccount = {
    id: `agy:${p.acc}`,
    configDir: p.stateDir,
    short: (/\d+$/.exec(p.acc)?.[0] ?? p.acc[0] ?? 'A').toUpperCase(),
    name: workerLabel(p),
    color: palette[index % palette.length],
  };
  if (p.email) d.email = p.email;
  return d;
}
