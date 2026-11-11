// Office rules ("Nội quy"): one set per office, kept in that office's record of ~/.agy_profiles/team.json (`rules`), so
// deleting the office deletes them. The user edits them in the page; a boss may only propose a rule (the user accepts or
// rejects it). Three parts:
// - scope: the office folder (+ `write` extras) is where files may be edited; `deny` paths may not even be read;
//   `commands` are command prefixes that may not run;
// - items: short rules, each for the boss, the workers or both, on/off;
// - limits: running jobs per office, and the quota % at which a worker gets no more jobs.
// Who enforces what: agy-ask / claude-ask put the rules at the top of every job and refuse a job outside the scope or
// over the limits; a PreToolUse hook (agy-hub) blocks a Claude worker's or boss's edit / command against the scope.
// Every refusal is one line of ~/.agy_profiles/rules-log.jsonl (RuleViolation), read by Habblaud.
// The checks below are pure and also written in Python (agy-hub); both run the cases of shared/rules.vectors.json.

export type RuleFor = 'all' | 'boss' | 'workers';

export interface OfficeRule {
  id: string;
  text: string;
  for: RuleFor;
  on: boolean;
}

/** A rule a boss suggested; it becomes an item only when the user accepts it. */
export interface RuleProposal {
  id: string;
  text: string;
  for: RuleFor;
  /** The boss's name. */
  by: string;
  at: number;
  why?: string;
}

export interface OfficeScope {
  /** Folders that may be edited besides the office folder (absolute or "~/…"). */
  write: string[];
  /** May not be read nor edited: a path ("/…" or "~/…", with everything inside it) or a name matched against every
   * part of a path ("*" = any characters), e.g. ".env*". */
  deny: string[];
  /** Command prefixes that may not run, e.g. "git push" (matched on each part of a command line). */
  commands: string[];
}

export interface OfficeLimits {
  /** Jobs running at once in this office; absent = no limit. */
  maxJobs?: number;
  /** A worker whose 5-hour or weekly quota use reaches this % gets no new job; absent = no limit. */
  quotaStop?: number;
}

export interface OfficeRules {
  scope: OfficeScope;
  items: OfficeRule[];
  limits: OfficeLimits;
  proposals: RuleProposal[];
  /** Bumped on every change: an edit made from an older copy is refused (409) instead of overwriting. */
  rev: number;
}

/** One refusal, a line of ~/.agy_profiles/rules-log.jsonl. */
export interface RuleViolation {
  at: number;
  office: string;
  /** Who tried: a worker id ("acc2", "claude:.claude-w") or "boss". */
  who: string;
  kind: 'deny' | 'outside' | 'command' | 'cwd' | 'jobs' | 'quota';
  /** The path, command or job folder refused (one line, cut to 200 characters). */
  detail: string;
  /** 'hook' = a tool call blocked inside a session; 'ask' = a job refused by agy-ask / claude-ask. */
  by: 'hook' | 'ask';
}

export const RULES_MAX = { items: 50, proposals: 20, text: 200, paths: 30, commands: 30 } as const;
/** Violations kept: this many days, at most this many lines. */
export const VIOLATIONS_KEEP = { days: 7, lines: 500 } as const;

export function defaultRules(): OfficeRules {
  return {
    scope: { write: [], deny: ['~/.ssh', '~/.gnupg', '.env', '.env.*'], commands: ['git push', 'sudo'] },
    items: [{ id: 'r1', text: 'Stay inside the task and the scope: if a rule blocks the work, stop and report instead of working around it.', for: 'workers', on: true }],
    limits: { quotaStop: 90 },
    proposals: [],
    rev: 0,
  };
}

const FOR: readonly RuleFor[] = ['all', 'boss', 'workers'];
const ID = /^[\w-]{1,24}$/;
const line = (x: unknown): string => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, RULES_MAX.text) : '');
const strings = (x: unknown, max: number): string[] => (Array.isArray(x) ? [...new Set(x.map(line).filter(Boolean))].slice(0, max) : []);
const num = (x: unknown, lo: number, hi: number): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : undefined);

/** The rules of a team.json office record; absent = the defaults, anything malformed is dropped. */
export function parseRules(raw: unknown): OfficeRules {
  if (!raw || typeof raw !== 'object') return defaultRules();
  const r = raw as Record<string, unknown>;
  const s = (r.scope ?? {}) as Record<string, unknown>;
  const l = (r.limits ?? {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const uid = (x: unknown, i: number, p: string): string => {
    let id = typeof x === 'string' && ID.test(x) && !ids.has(x) ? x : `${p}${i + 1}`;
    while (ids.has(id)) id += 'x';
    ids.add(id);
    return id;
  };
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((x: Record<string, unknown>, i) => ({ id: uid(x?.id, i, 'r'), text: line(x?.text), for: FOR.includes(x?.for as RuleFor) ? (x.for as RuleFor) : 'all', on: x?.on !== false }))
    .filter((x) => x.text)
    .slice(0, RULES_MAX.items);
  const proposals = (Array.isArray(r.proposals) ? r.proposals : [])
    .map((x: Record<string, unknown>, i) => ({
      id: uid(x?.id, i, 'p'),
      text: line(x?.text),
      for: FOR.includes(x?.for as RuleFor) ? (x.for as RuleFor) : 'all',
      by: line(x?.by) || 'boss',
      at: typeof x?.at === 'number' ? x.at : 0,
      ...(line(x?.why) ? { why: line(x?.why) } : {}),
    }))
    .filter((x) => x.text)
    .slice(-RULES_MAX.proposals);
  const maxJobs = num(l.maxJobs, 1, 50);
  const quotaStop = num(l.quotaStop, 1, 100);
  return {
    scope: {
      write: strings(s.write, RULES_MAX.paths).filter((p) => p.startsWith('/') || p.startsWith('~/')),
      deny: Array.isArray(s.deny) ? strings(s.deny, RULES_MAX.paths) : defaultRules().scope.deny,
      commands: Array.isArray(s.commands) ? strings(s.commands, RULES_MAX.commands) : defaultRules().scope.commands,
    },
    items,
    limits: { ...(maxJobs ? { maxJobs } : {}), ...(quotaStop ? { quotaStop } : {}) },
    proposals,
    rev: num(r.rev, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

/** "/a/./b/../c/" -> "/a/c" ("~/" expanded with `home`); '' for a relative path. */
export function normPath(path: string, home: string): string {
  const p = path.trim() === '~' ? home : path.trim().startsWith('~/') ? `${home}/${path.trim().slice(2)}` : path.trim();
  if (!p.startsWith('/')) return '';
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Is `path` the folder `dir` or inside it (both normalized)? */
export const inside = (path: string, dir: string): boolean => dir === '/' || path === dir || path.startsWith(`${dir}/`);

const glob = (pattern: string, name: string): boolean => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);

export interface ScopeCheck {
  ok: boolean;
  kind?: 'deny' | 'outside';
  /** The rule that refused it (a deny entry, or the office folder). */
  rule?: string;
}

/**
 * May this path be read (`read`) or edited (`write`) under the office's scope? `folder`: the office folder ('' = none:
 * only `deny` applies). A relative path is taken inside `cwd`.
 */
export function checkPath(rules: Pick<OfficeRules, 'scope'>, at: { folder: string; home: string; cwd?: string }, path: string, mode: 'read' | 'write'): ScopeCheck {
  const abs = normPath(path.startsWith('/') || path.startsWith('~') ? path : `${at.cwd ?? at.folder ?? '/'}/${path}`, at.home);
  if (!abs) return { ok: true };
  const parts = abs.split('/').filter(Boolean);
  for (const d of rules.scope.deny) {
    const hit = d.startsWith('/') || d.startsWith('~/') ? inside(abs, normPath(d, at.home)) : parts.some((p) => glob(d, p));
    if (hit) return { ok: false, kind: 'deny', rule: d };
  }
  if (mode === 'read' || !at.folder) return { ok: true };
  const dirs = [at.folder, ...rules.scope.write].map((d) => normPath(d, at.home)).filter(Boolean);
  return dirs.some((d) => inside(abs, d)) ? { ok: true } : { ok: false, kind: 'outside', rule: at.folder };
}

/** The parts of a command line ("a && b | c; d" -> a, b, c, d), each without leading "VAR=x" assignments. */
export function commandParts(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;|\n&]/)
    .map((p) => p.replace(/\s+/g, ' ').trim().replace(/^(?:[A-Za-z_]\w*=\S* )+/, ''))
    .filter(Boolean);
}

/** The forbidden prefix this command line uses, or undefined. Best effort: `bash -c "…"` or scripts are not opened. */
export function checkCommand(rules: Pick<OfficeRules, 'scope'>, cmd: string): string | undefined {
  const parts = commandParts(cmd);
  return rules.scope.commands.find((c) => {
    const n = c.replace(/\s+/g, ' ').trim();
    return parts.some((p) => p === n || p.startsWith(`${n} `));
  });
}

/**
 * The rules as the agent reads them (top of a worker's job; the boss's session start). Short on purpose: it is paid in
 * tokens on every job.
 */
export function rulesText(office: { name: string; folder: string }, rules: OfficeRules, who: 'boss' | 'workers'): string {
  const out = [`Office rules of "${office.name}" (set by the user; they win over the task):`];
  const inside = [office.folder, ...rules.scope.write].join(', ');
  if (office.folder && who === 'boss') out.push(`- Office folder: ${office.folder}. Workers edit only inside ${inside}; you may also edit outside it.`);
  else if (office.folder) out.push(`- Edit files only inside: ${inside}.`);
  if (rules.scope.deny.length) out.push(`- Never read or edit: ${rules.scope.deny.join(', ')}.`);
  if (rules.scope.commands.length) out.push(`- Never run: ${rules.scope.commands.join(', ')}.`);
  for (const r of rules.items) if (r.on && (r.for === 'all' || r.for === who)) out.push(`- ${r.text}`);
  if (who === 'boss') {
    if (rules.limits.maxJobs) out.push(`- At most ${rules.limits.maxJobs} jobs running at once in this office.`);
    out.push('- You cannot change these rules. To suggest one: agy-ask rules propose "<rule>" --why "<reason>" (the user decides).');
  }
  return out.join('\n');
}
