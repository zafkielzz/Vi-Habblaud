// The offices: each one is a team working in ONE project folder — one boss (orchestrator) and the accounts registered as
// its workers — chosen in the office (office tabs, sidebar ＋ and the drawer) and kept in <agy root>/team.json
// (~/.agy_profiles/team.json), next to the workers, not inside Habblaud, because agy-ask / claude-ask read the same file
// to enforce it from any terminal: a caller that is some office's boss may only give jobs to that office's workers.
// Habblaud is just the editor.
//
// A boss is either a Claude Code main session, found again by its agent id ("<account>:<pid>") or, after
// `claude --resume` (new pid), by account + session id; or an Antigravity account ("agy:accN") whose terminal the office
// opens (agy-ask recognises it by an ancestor `agy` process with that profile's HOME). While a Claude boss is closed its
// crown waits for it. "＋ Boss" opens a session and appoints it before it shows up (pending: the record has its id only,
// filled in when it appears).
//
// Workers (WorkerId): an Antigravity profile ("acc2") or a Claude Code account ("claude:<account id>"). Workers may sit
// in several offices (their jobs go through agy-ask; a busy one answers BUSY). A boss session leads one office; an
// Antigravity account bosses at most one office and is then nobody's worker (one agy per profile); within an office the
// boss's account is not a worker. Two offices never share a folder.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AgentInfo, HandoffPlan, OfficeInfo, TeamInfo, WorkerKind } from '../shared/types';
import type { Office } from './model/office';
import { normalizeCwd } from './model/rooms';
import { FOLDER_CLASH, folderRelation, isDiskRoot, writeFolderClash } from '../shared/folders';
import { pidAlive } from './sources/registry';
import { normPath, parseRules, RULES_MAX, type OfficeRules, type RuleFor, type RuleViolation } from '../shared/rules';
import { tr } from '../shared/i18n';

/** How often the crowns are put back on the right heads (sessions come, go and resume). */
const TICK_MS = 1_000;

/** WorkerId prefix of a Claude Code account. */
export const CLAUDE_WORKER = 'claude:';

/** Id of the office carried over from a team file without offices. */
export const FIRST_OFFICE = 'main';

export interface BossRecord {
  kind: WorkerKind;
  /** Agent id: "<account>:<pid>" (Claude) or "agy:accN" (Antigravity). */
  id: string;
  account: string;
  /** Antigravity profile (kind 'agy'). */
  acc?: string;
  /** Empty while pending (the session was opened from the office and has not shown up yet); unused for agy. */
  sessionId: string;
  /** Claude Code PID (the number in `id`): what agy-ask compares with the PID of the Claude that calls it; 0 for agy. */
  pid: number;
  name: string;
  /** When it was appointed (epoch ms). */
  at: number;
}

export interface OfficeRecord {
  id: string;
  name: string;
  /** Absolute project folder; '' = not declared yet (carried over from a team file without offices). */
  folder: string;
  boss?: BossRecord;
  /** Registered workers (WorkerId). */
  workers: string[];
  /** The office rules (shared/rules.ts); absent = the defaults (written only once the user or a boss changes them). */
  rules?: OfficeRules;
}

export interface TeamFile {
  offices: OfficeRecord[];
}

export type TeamResult = { ok: true } | { ok: false; status: number; error: string };

/** Only an open Claude Code main session can be a Claude boss (not a subagent, a Codex thread or a worker). */
export function canBeBoss(a: Pick<AgentInfo, 'kind' | 'provider' | 'status' | 'id'>): boolean {
  return a.kind === 'main' && (a.provider ?? 'claude') === 'claude' && a.status !== 'offline' && a.status !== 'done' && pidOf(a.id) > 0;
}

/** The open session the record points to: same agent id, else same account and session (resumed). */
export function findBoss(rec: BossRecord | undefined, agents: readonly AgentInfo[]): AgentInfo | undefined {
  if (!rec) return undefined;
  if (rec.kind === 'agy') return agents.find((a) => a.id === rec.id && a.status !== 'offline');
  const open = agents.filter(canBeBoss);
  return open.find((a) => a.id === rec.id) ?? (rec.sessionId ? open.find((a) => a.account === rec.account && a.sessionId === rec.sessionId) : undefined);
}

const pidOf = (id: string): number => Number(/:(\d+)$/.exec(id)?.[1] ?? 0);

const WORKER_ID = /^(?:claude:[\w.~-]+|[\w.-]+)$/;
const OFFICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Account id (AccountInfo.id) of a worker: "acc2" -> "agy:acc2", "claude:.claude-w" -> ".claude-w". */
export function workerAccount(worker: string): string {
  return worker.startsWith(CLAUDE_WORKER) ? worker.slice(CLAUDE_WORKER.length) : `agy:${worker}`;
}

const byName = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });

/** "FinSTAR labels" -> "finstar-labels" (ASCII, for ids). */
export function officeSlug(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'office';
}

/** A folder as offices compare them: absolute, normalized, without a trailing separator. */
export function officeFolder(path: string): string {
  return path ? normalizeCwd(resolve(path)) : '';
}

function parseBoss(b: Partial<BossRecord> | null | undefined): BossRecord | undefined {
  if (b?.kind === 'agy' && typeof b.acc === 'string' && /^[\w.-]+$/.test(b.acc)) {
    const id = `agy:${b.acc}`;
    return { kind: 'agy', id, account: id, acc: b.acc, sessionId: '', pid: 0, name: typeof b.name === 'string' ? b.name : b.acc, at: typeof b.at === 'number' ? b.at : 0 };
  }
  if (!b || typeof b.id !== 'string' || typeof b.account !== 'string') return undefined;
  return { kind: 'claude', id: b.id, account: b.account, sessionId: typeof b.sessionId === 'string' ? b.sessionId : '', pid: pidOf(b.id), name: typeof b.name === 'string' ? b.name : '', at: typeof b.at === 'number' ? b.at : 0 };
}

const workerList = (w: unknown): string[] => (Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && WORKER_ID.test(x)) : []);

/**
 * Parses team.json; anything malformed is dropped (a bad boss = no boss, bad names skipped). A file from before offices
 * ({boss, workers}) becomes the first office, without a folder yet.
 */
export function parseTeam(text: string): TeamFile {
  const raw = JSON.parse(text) as { offices?: unknown; boss?: Partial<BossRecord> | null; workers?: unknown };
  if (!Array.isArray(raw.offices)) {
    const boss = parseBoss(raw.boss);
    return { offices: [{ id: FIRST_OFFICE, name: 'Office', folder: '', workers: workerList(raw.workers), ...(boss ? { boss } : {}) }] };
  }
  const offices: OfficeRecord[] = [];
  for (const o of raw.offices as Array<Record<string, unknown>>) {
    if (!o || typeof o.id !== 'string' || !OFFICE_ID.test(o.id) || offices.some((x) => x.id === o.id)) continue;
    const boss = parseBoss(o.boss as Partial<BossRecord> | undefined);
    const folder = typeof o.folder === 'string' && isAbsolute(o.folder) ? officeFolder(o.folder) : '';
    offices.push({ id: o.id, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : o.id, folder, workers: workerList(o.workers), ...(boss ? { boss } : {}), ...(o.rules ? { rules: parseRules(o.rules) } : {}) });
  }
  if (!offices.length) offices.push({ id: FIRST_OFFICE, name: 'Office', folder: '', workers: [] });
  return { offices };
}

export interface TeamServiceOptions {
  office: Office;
  /** <agy root>/team.json. */
  file: string;
  /** Logged-in Antigravity profiles: profile name (accN) and account id, registered or not. */
  profiles: () => Array<{ acc: string; account: string }>;
  /** Re-reads the profiles folder now (it is re-read every 30 s anyway): an account signed in moments ago. */
  rescanProfiles?: () => void;
  /** Claude Code accounts that can be workers: WorkerId ("claude:<id>") and account id. */
  claudeAccounts?: () => Array<{ worker: string; account: string }>;
  /** Workers of a brand-new team.json: the profiles in use until now (not "off" in roles.conf). */
  seed: () => string[];
  /** Habblaud's old boss.json (before the team file), read once when team.json does not exist yet. */
  legacyBossFile?: string;
  /**
   * Called after workers or bosses change: every registered worker (any office) and the Antigravity bosses' profiles
   * (sources add or remove characters; each Antigravity boss gets one and a terminal).
   */
  onWorkers?: (workers: readonly string[], agyBosses: readonly string[]) => void;
  /** The office's recent rule violations (server/rules-log.ts), newest first. */
  violations?: (officeId: string) => RuleViolation[];
  /** An office was deleted (its running jobs are cancelled). */
  onDeleteOffice?: (id: string) => void;
  /** Worker sessions and jobs for the snapshot (server/workers). */
  extra?: () => Pick<TeamInfo, 'sessions' | 'jobs'>;
  now?: () => number;
  /** Is this PID running? (a pending boss whose Claude Code exited before showing up is dropped). */
  isAlive?: (pid: number) => boolean;
  /**
   * The workers' room of an office's building: the first office uses the Antigravity room (agy-hub), the others
   * "<that room>@<office id>" (named "Workers"). Absent = no workers rooms (tests).
   */
  workersRoom?: (officeId: string, first: boolean) => string;
  /** The user's home folder (never learned as an office folder; tests). */
  home?: string;
  /** Is this an existing folder? (tests) */
  isDir?: (path: string) => boolean;
  /** The folder with its symlinks resolved (tests; default realpath, else the path itself). */
  realpath?: (path: string) => string;
  /** The "next steps" of a folder's HANDOFF file (BoardService.folderPlan): OfficeInfo.plan. */
  folderPlan?: (folder: string) => HandoffPlan | undefined;
}

export type OfficeResult = { ok: true; office: OfficeInfo } | { ok: false; status: number; error: string };

/**
 * A worker's character in one office (its "seat"): one per office the worker belongs to. The first office that has
 * the worker keeps the plain character id (`base`); the next ones get "<base>@<office>" and a name ending in " (n)".
 */
export interface Seat {
  worker: string;
  office: string;
  /** 1 for the first office that has the worker, then 2, 3… */
  n: number;
  agentId: string;
}

/** The plain character id of a worker: "agy:accN", or "claude-worker:<account>" for a Claude Code account. */
export function workerAgentId(worker: string): string {
  return worker.startsWith(CLAUDE_WORKER) ? `claude-worker:${worker.slice(CLAUDE_WORKER.length)}` : `agy:${worker}`;
}

/** " (2)" for a worker's second seat, "" for its first. */
export const seatSuffix = (n: number): string => (n > 1 ? ` (${n})` : '');

/** Every seat, office by office in creation order. */
export function teamSeats(offices: readonly Pick<OfficeRecord, 'id' | 'workers'>[]): Seat[] {
  const count = new Map<string, number>();
  const out: Seat[] = [];
  for (const o of offices) {
    for (const worker of o.workers) {
      const n = (count.get(worker) ?? 0) + 1;
      count.set(worker, n);
      out.push({ worker, office: o.id, n, agentId: n === 1 ? workerAgentId(worker) : `${workerAgentId(worker)}@${o.id}` });
    }
  }
  return out;
}

/** Is `path` the folder or inside it? */
const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

export class TeamService {
  private team: TeamFile;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Bosses that already got their coronation (party and feed line), by office. */
  private readonly announced = new Map<string, string>();

  constructor(private readonly opts: TeamServiceOptions) {
    this.team = this.load();
  }

  start(): void {
    this.sync();
    this.timer = setInterval(() => this.sync(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get offices(): readonly OfficeRecord[] {
    return this.team.offices;
  }

  /** An office by id (none given = the first one). */
  officeOf(id?: string): OfficeRecord | undefined {
    return id ? this.team.offices.find((o) => o.id === id) : this.team.offices[0];
  }

  /** Every worker's character per office (server/workers, sources/agy). */
  seats(): Seat[] {
    return teamSeats(this.team.offices);
  }

  /** The workers' room of an office's building (a folder-like path; its room id is the same string normalized). */
  workersRoomOf(officeId: string): string | undefined {
    const first = this.team.offices[0]?.id === officeId;
    return this.opts.workersRoom?.(officeId, first);
  }

  /** Every registered worker, any office. */
  get workers(): readonly string[] {
    return [...new Set(this.team.offices.flatMap((o) => o.workers))].sort(byName);
  }

  /** Profiles of the Antigravity bosses. */
  get agyBosses(): string[] {
    return this.team.offices.flatMap((o) => (o.boss?.kind === 'agy' && o.boss.acc ? [o.boss.acc] : []));
  }

  /** Is this a registered worker (of that office, or of any)? */
  isWorker(worker: string, office?: string): boolean {
    return office ? !!this.officeOf(office)?.workers.includes(worker) : this.team.offices.some((o) => o.workers.includes(worker));
  }

  /** The first office that has this worker (a job without an office goes there). */
  officeOfWorker(worker: string): string | undefined {
    return this.team.offices.find((o) => o.workers.includes(worker))?.id;
  }

  /**
   * Appoints `agentId` (a Claude Code session) the boss of an office (its previous boss becomes a normal session), or
   * `null` = that office has no boss. `pending`: a session just opened from the office ("＋ Boss") that has not shown up.
   */
  appoint(officeId: string | undefined, agentId: string | null, pending?: { account: string }): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    if (agentId === null) {
      delete o.boss;
      this.changed();
      return { ok: true };
    }
    const elsewhere = this.team.offices.find((x) => x !== o && x.boss?.id === agentId);
    if (elsewhere) return { ok: false, status: 409, error: tr('this session is already the boss of {0}', [elsewhere.name]) };
    const a = this.opts.office.get(agentId);
    const now = (this.opts.now ?? Date.now)();
    if (!a) {
      // A pending boss: "<account>:<pid>" of the Claude Code just opened in that account.
      if (!pending || !pidOf(agentId) || !agentId.startsWith(`${pending.account}:`)) return { ok: false, status: 404, error: tr('agent not found') };
      o.boss = { kind: 'claude', id: agentId, account: pending.account, sessionId: '', pid: pidOf(agentId), name: '', at: now };
      o.workers = o.workers.filter((w) => w !== `${CLAUDE_WORKER}${pending.account}`);
      this.announced.delete(o.id);
      this.changed();
      return { ok: true };
    }
    if (!canBeBoss(a)) return { ok: false, status: 400, error: tr('only an open Claude Code session can be the boss') };
    if (o.boss?.id === a.id) return { ok: true };
    o.boss = { kind: 'claude', id: a.id, account: a.account, sessionId: a.sessionId, pid: pidOf(a.id), name: a.name, at: now };
    o.workers = o.workers.filter((w) => w !== `${CLAUDE_WORKER}${a.account}`);
    this.announced.set(o.id, a.id);
    this.changed();
    this.crown(a);
    return { ok: true };
  }

  /** Appoints an Antigravity account the boss of an office (the caller opens its terminal); it is nobody's worker then. */
  appointAgy(officeId: string | undefined, acc: string, displayName?: string): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const p = this.opts.profiles().find((x) => x.acc === acc);
    if (!p) return { ok: false, status: 404, error: tr('Antigravity account not found: {0}', [acc]) };
    const id = `agy:${acc}`;
    if (o.boss?.id === id) return { ok: true };
    const elsewhere = this.team.offices.find((x) => x !== o && x.boss?.id === id);
    if (elsewhere) return { ok: false, status: 409, error: tr('{0} is already the boss of {1} (one Antigravity terminal per account)', [acc, elsewhere.name]) };
    const name = displayName ?? this.opts.office.get(id)?.name ?? acc;
    o.boss = { kind: 'agy', id, account: p.account, acc, sessionId: '', pid: 0, name, at: (this.opts.now ?? Date.now)() };
    for (const x of this.team.offices) x.workers = x.workers.filter((w) => w !== acc);
    this.announced.delete(o.id);
    this.changed();
    return { ok: true };
  }

  /** Registers an account as one of the office's workers (`on`) or removes it. */
  setWorker(officeId: string | undefined, worker: string, on: boolean): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    if (on) {
      const isProfile = () => this.opts.profiles().some((p) => p.acc === worker);
      let known = worker.startsWith(CLAUDE_WORKER) ? (this.opts.claudeAccounts?.() ?? []).some((c) => c.worker === worker) : isProfile();
      // A profile signed in since the last periodic re-read: look again before refusing.
      if (!known && !worker.startsWith(CLAUDE_WORKER) && this.opts.rescanProfiles) {
        this.opts.rescanProfiles();
        known = isProfile();
      }
      if (!known) return { ok: false, status: 404, error: tr('account not found: {0}', [worker]) };
      if (o.boss && workerAccount(worker) === o.boss.account) return { ok: false, status: 409, error: tr('{0} is the boss: the boss cannot be a worker', [worker]) };
      const agyBoss = this.team.offices.find((x) => x.boss?.kind === 'agy' && x.boss.acc === worker);
      if (agyBoss) return { ok: false, status: 409, error: tr('{0} is the boss of {1}: an Antigravity boss cannot be a worker', [worker, agyBoss.name]) };
    }
    const has = o.workers.includes(worker);
    if (has === on) return { ok: true };
    o.workers = on ? [...o.workers, worker].sort(byName) : o.workers.filter((w) => w !== worker);
    this.changed();
    return { ok: true };
  }

  /** A new office for a project folder (absolute, existing, used by no other office). */
  createOffice(name: string, folder: string): OfficeResult {
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n) return { ok: false, status: 400, error: tr('the office needs a name') };
    const f = this.checkFolder(folder);
    if (typeof f !== 'string') return f;
    let id = officeSlug(n);
    for (let i = 2; this.team.offices.some((o) => o.id === id); i++) id = `${officeSlug(n).slice(0, 36)}-${i}`;
    const o: OfficeRecord = { id, name: n, folder: f, workers: [] };
    this.team.offices.push(o);
    this.changed();
    return { ok: true, office: this.info(o) };
  }

  renameOffice(officeId: string | undefined, name: string): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n) return { ok: false, status: 400, error: tr('the office needs a name') };
    o.name = n;
    this.changed();
    return { ok: true };
  }

  /** The office's rules (the defaults until changed). */
  rulesOf(officeId: string | undefined): OfficeRules | undefined {
    const o = this.officeOf(officeId);
    return o ? (o.rules ?? parseRules(undefined)) : undefined;
  }

  /**
   * The user saves the office's rules. `rev`: the revision they were edited from (an older one = 409, nothing written).
   * The boss's proposals are kept as they are on the server. An extra write folder may not overlap another office's.
   */
  setRules(officeId: string | undefined, raw: unknown, rev: number): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const cur = this.rulesOf(o.id)!;
    if (rev !== cur.rev) return { ok: false, status: 409, error: tr('the rules changed meanwhile: reload them') };
    const next = parseRules(raw);
    const home = this.opts.home ?? homedir();
    for (const w of next.scope.write) {
      const p = normPath(w, home);
      if (p === '/' || p === normPath(home, home)) return { ok: false, status: 400, error: tr('{0} is too wide to be a write folder', [w]) };
      const other = writeFolderClash(p, this.team.offices, o.id);
      if (other) return { ok: false, status: 409, error: tr('{0} overlaps the folder of {1}', [w, other.name]) };
    }
    o.rules = { ...next, proposals: cur.proposals, rev: cur.rev + 1 };
    this.changed();
    return { ok: true };
  }

  /** A boss suggests a rule (the user accepts or rejects it in the page). */
  proposeRule(officeId: string | undefined, p: { text: string; for?: RuleFor; why?: string; by?: string }): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const cur = this.rulesOf(o.id)!;
    const text = p.text.replace(/\s+/g, ' ').trim().slice(0, RULES_MAX.text);
    if (!text) return { ok: false, status: 400, error: tr('the rule is empty') };
    if (cur.proposals.some((x) => x.text === text) || cur.items.some((x) => x.text === text)) return { ok: true };
    const ids = new Set([...cur.items, ...cur.proposals].map((x) => x.id));
    let n = cur.proposals.length + 1;
    while (ids.has(`p${n}`)) n++;
    const by = p.by?.trim().slice(0, 80) || o.boss?.name || 'boss';
    const proposal = { id: `p${n}`, text, for: p.for ?? 'all', by, at: (this.opts.now ?? Date.now)(), ...(p.why?.trim() ? { why: p.why.trim().slice(0, RULES_MAX.text) } : {}) };
    o.rules = { ...cur, proposals: [...cur.proposals, proposal].slice(-RULES_MAX.proposals), rev: cur.rev + 1 };
    this.changed();
    return { ok: true };
  }

  /** The user accepts (it becomes a rule, on) or rejects a boss's proposal. */
  decideRule(officeId: string | undefined, id: string, accept: boolean): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const cur = this.rulesOf(o.id)!;
    const p = cur.proposals.find((x) => x.id === id);
    if (!p) return { ok: false, status: 404, error: tr('proposal not found: {0}', [id]) };
    if (accept && cur.items.length >= RULES_MAX.items) return { ok: false, status: 409, error: tr('too many rules: remove one first') };
    const ids = new Set(cur.items.map((x) => x.id));
    let n = cur.items.length + 1;
    while (ids.has(`r${n}`)) n++;
    o.rules = {
      ...cur,
      items: accept ? [...cur.items, { id: `r${n}`, text: p.text, for: p.for, on: true }] : cur.items,
      proposals: cur.proposals.filter((x) => x !== p),
      rev: cur.rev + 1,
    };
    this.changed();
    return { ok: true };
  }

  /** Declares (or moves) the office's folder. */
  setFolder(officeId: string | undefined, folder: string): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId ?? '']) };
    const f = this.checkFolder(folder, o);
    if (typeof f !== 'string') return f;
    o.folder = f;
    this.changed();
    return { ok: true };
  }

  /** Deletes an office (not the last one): its boss steps down, its running jobs are cancelled. */
  deleteOffice(officeId: string): TeamResult {
    const o = this.officeOf(officeId);
    if (!o) return { ok: false, status: 404, error: tr('office not found: {0}', [officeId]) };
    if (this.team.offices.length === 1) return { ok: false, status: 409, error: tr('the last office cannot be deleted') };
    this.team.offices = this.team.offices.filter((x) => x !== o);
    this.announced.delete(o.id);
    this.opts.onDeleteOffice?.(o.id);
    this.changed();
    return { ok: true };
  }

  /** Puts the crowns on the bosses (if open), takes them off everyone else, and shows the offices in the snapshot. */
  sync(): void {
    const office = this.opts.office;
    const agents = office.list();
    const crowned = new Set<string>();
    let dirty = false;
    for (const o of this.team.offices) {
      let rec = o.boss;
      const boss = findBoss(rec, agents);
      // "＋ Boss" opened a Claude Code that exited before showing up (e.g. "No, exit" at the trust question): no boss,
      // instead of "Opening the new boss…" forever (and its account barred from Workers).
      if (!boss && rec?.kind === 'claude' && !rec.sessionId && rec.pid && !(this.opts.isAlive ?? pidAlive)(rec.pid)) {
        delete o.boss;
        rec = undefined;
        dirty = true;
      }
      if (boss && rec?.kind === 'claude' && (boss.id !== rec.id || boss.sessionId !== rec.sessionId || boss.name !== rec.name)) {
        o.boss = { ...rec, id: boss.id, sessionId: boss.sessionId, pid: pidOf(boss.id), name: boss.name };
        dirty = true;
      }
      // An office carried over from the old team file learns its folder from its open boss (not the home folder: that
      // is no project; the page asks for one instead).
      if (!o.folder && boss) {
        const path = office.roomPath(boss.roomId);
        if (path && officeFolder(path) !== officeFolder(this.opts.home ?? homedir()) && !this.team.offices.some((x) => x !== o && x.folder === officeFolder(path))) {
          o.folder = officeFolder(path);
          dirty = true;
        }
      }
      if (boss) {
        crowned.add(boss.id);
        // A boss opened from the office gets its coronation when it walks in.
        if (this.announced.get(o.id) !== boss.id) {
          this.announced.set(o.id, boss.id);
          if (rec && (rec.kind === 'agy' || !rec.sessionId)) this.crown(boss);
        }
      }
    }
    for (const a of agents) if (a.kind === 'main') office.setBoss(a.id, crowned.has(a.id));
    if (dirty) this.changed(false);
    this.place(agents);
    this.publish();
  }

  /**
   * Which building holds each room and each character. Rooms: an office's workers room, then a room where some
   * office's boss sits, then the office whose folder holds the room's path (the deepest one); characters: a boss in its
   * office, a worker's seat in its office, anyone else in the building of their room. Unplaced = the first building.
   */
  private place(agents: readonly AgentInfo[]): void {
    const office = this.opts.office;
    const rooms = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const o of this.team.offices) {
      const path = this.workersRoomOf(o.id);
      if (!path) continue;
      rooms.set(normalizeCwd(path), o.id);
      if (o !== this.team.offices[0]) labels.set(normalizeCwd(path), tr('Workers'));
    }
    const who = new Map<string, string>();
    for (const o of this.team.offices) {
      const boss = findBoss(o.boss, agents);
      if (!boss) continue;
      who.set(boss.id, o.id);
      if (!rooms.has(boss.roomId)) rooms.set(boss.roomId, o.id);
    }
    const byDepth = this.team.offices.filter((o) => o.folder).sort((a, b) => b.folder.length - a.folder.length);
    for (const r of office.roomList()) {
      if (rooms.has(r.id)) continue;
      const path = officeFolder(r.path);
      const o = byDepth.find((x) => within(path, x.folder));
      if (o) rooms.set(r.id, o.id);
    }
    for (const s of this.seats()) who.set(s.agentId, s.office);
    const placed = new Map<string, string>();
    for (const a of agents) {
      const o = who.get(a.id) ?? rooms.get(a.roomId);
      if (o) placed.set(a.id, o);
    }
    office.setRoomLabels(labels);
    office.setPlacement(rooms, placed);
  }

  /** Sends the offices to the snapshot now (worker sessions and jobs changed). */
  publish(): void {
    const offices = this.team.offices.map((o) => this.info(o));
    const first = offices[0];
    const info: TeamInfo = { offices, workers: [...(first?.workers ?? [])], agy: this.opts.profiles() };
    const claude = this.opts.claudeAccounts?.();
    if (claude) info.claude = claude;
    for (const k of ['bossAccount', 'bossKind', 'pendingBoss', 'waitingBoss'] as const) if (first?.[k]) (info as unknown as Record<string, unknown>)[k] = first[k];
    Object.assign(info, this.opts.extra?.() ?? {});
    this.opts.office.setTeam(info);
  }

  private info(o: OfficeRecord): OfficeInfo {
    const out: OfficeInfo = { id: o.id, name: o.name, folder: o.folder, workers: [...o.workers], rules: o.rules ?? parseRules(undefined) };
    const violations = this.opts.violations?.(o.id);
    if (violations?.length) out.violations = violations;
    const workersRoom = this.workersRoomOf(o.id);
    if (workersRoom) out.workersRoomId = normalizeCwd(workersRoom);
    const agents = this.opts.office.list();
    if (o.folder) {
      const room = this.opts.office.roomList().find((r) => officeFolder(r.path) === o.folder);
      if (room) out.roomId = room.id;
      const plan = this.opts.folderPlan?.(o.folder);
      if (plan) out.plan = plan;
    }
    const rec = o.boss;
    if (rec) {
      out.bossAccount = rec.account;
      out.bossKind = rec.kind;
      const boss = findBoss(rec, agents);
      if (boss) out.bossAgentId = boss.id;
      else if (rec.kind === 'claude' && !rec.sessionId) out.pendingBoss = rec.id;
      else out.waitingBoss = rec.name || rec.id;
    }
    return out;
  }

  /**
   * A valid office folder (normalized, symlinks resolved), or why not: absolute, an existing folder, not the whole
   * disk, and not overlapping another office's folder (the same, inside it or holding it; also through a symlink).
   */
  private checkFolder(folder: string, self?: OfficeRecord): string | { ok: false; status: number; error: string } {
    if (!folder || !isAbsolute(folder)) return { ok: false, status: 400, error: tr('the folder must be an absolute path') };
    const f = officeFolder(folder);
    if (!(this.opts.isDir ?? isDir)(f)) return { ok: false, status: 400, error: tr('folder not found: {0}', [f]) };
    const real = officeFolder((this.opts.realpath ?? realFolder)(f));
    if (isDiskRoot(real)) return { ok: false, status: 400, error: tr('the whole disk ({0}) cannot be an office folder: pick a project folder', [real]) };
    for (const o of this.team.offices) {
      if (o === self || !o.folder) continue;
      const rel = folderRelation(real, officeFolder((this.opts.realpath ?? realFolder)(o.folder)));
      if (!FOLDER_CLASH.has(rel)) continue;
      const error =
        rel === 'inside' ? tr('this folder is inside the folder of {0}', [o.name]) : rel === 'contains' ? tr('this folder holds the folder of {0}', [o.name]) : tr('{0} already works in this folder', [o.name]);
      return { ok: false, status: 409, error };
    }
    return real;
  }

  /** Saves, tells the sources, and (unless called from sync itself) puts the crowns back. */
  private changed(resync = true): void {
    this.save();
    this.opts.onWorkers?.(this.workers, this.agyBosses);
    if (resync) this.sync();
  }

  private crown(a: AgentInfo): void {
    this.opts.office.celebrate(a.id, tr('👑 {0} is the boss', [a.name]), tr('👑 {0} is now the boss (orchestrator)', [a.name]));
  }

  private load(): TeamFile {
    try {
      return parseTeam(readFileSync(this.opts.file, 'utf8'));
    } catch {
      // first run (or unreadable file): the workers in use until now, and the boss Habblaud kept before
    }
    const first: OfficeRecord = { id: FIRST_OFFICE, name: 'Office', folder: '', workers: this.opts.seed() };
    if (this.opts.legacyBossFile && existsSync(this.opts.legacyBossFile)) {
      try {
        const boss = parseBoss(JSON.parse(readFileSync(this.opts.legacyBossFile, 'utf8')) as Partial<BossRecord>);
        if (boss) first.boss = boss;
      } catch {
        // no usable old boss
      }
    }
    this.team = { offices: [first] };
    this.save();
    return this.team;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      const tmp = `${this.opts.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.team, null, 2)}\n`);
      renameSync(tmp, this.opts.file);
    } catch {
      // read-only folder: the team lasts until the server restarts
    }
  }
}

/** The path with its symlinks resolved; the path itself when that fails. */
function realFolder(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
