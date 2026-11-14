// The team and the workers' terminals, from the page: POST /api/team (server/team.ts) and /api/workers/* (server/workers).
// A worker is an Antigravity profile ("acc2") or a Claude Code account ("claude:<account id>"), or a clone of one
// ("acc2#2": one more session of the account, shared/workers.ts); each registered worker has a standing terminal to
// watch. The boss gives jobs through agy-ask / claude-ask; here you give them too and cancel them.
// Errors become Error with the server's message (a BUSY answer's `message`, else `error`).
import type { AgentInfo, OfficeInfo, PtyInfo, TeamInfo, WorkerId, WorkerJob, WorkerKind, WorkerSession } from '../../../shared/types';
import type { OfficeRules } from '../../../shared/rules';
import { tr } from '../../../shared/i18n';
import { nextWorkerId, splitWorker, workerBase } from '../../../shared/workers';

/** A refusal from the server, with its HTTP status (e.g. 409 = changed meanwhile). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(tr("Habblaud didn't respond"));
  }
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(j.message ?? j.error ?? tr('error {0}', [res.status]), res.status);
  return j;
}

/** `{office}` when there is one (a server from before offices ignores it; without it = the first office). */
const inOffice = (office?: string): { office?: string } => (office ? { office } : {});

/**
 * Appoints a Claude Code session as the boss of an office (null = no boss). `pendingAccount` = a session just opened,
 * not in the office yet.
 */
export function appointBoss(agentId: string | null, pendingAccount?: string, office?: string): Promise<unknown> {
  return post('/api/team', { ...inOffice(office), boss: agentId, ...(pendingAccount ? { pendingAccount } : {}) });
}

/**
 * Makes an Antigravity profile the boss of an office: the server opens its terminal (`agy-as accN`, in `cwd`, by
 * default the office's folder).
 */
export async function appointAgyBoss(acc: string, cwd?: string, office?: string): Promise<PtyInfo | undefined> {
  const r = await post<{ pty?: PtyInfo }>('/api/team', { ...inOffice(office), bossAgy: acc, ...(cwd ? { cwd } : {}) });
  return r.pty;
}

/** Registers (on) or removes (off) a worker of an office. */
export function setWorker(worker: WorkerId, on: boolean, office?: string): Promise<unknown> {
  return post('/api/team', { ...inOffice(office), worker, on });
}

/**
 * Saves an office's rules (scope, items, limits; the proposals stay the server's). `rev`: the version edited; an older
 * one is refused with ApiError status 409.
 */
export function saveRules(office: string, rules: Pick<OfficeRules, 'scope' | 'items' | 'limits'>, rev: number): Promise<unknown> {
  return post('/api/team', { office, rules, rev });
}

/** Accepts (it becomes a rule) or rejects a rule the boss proposed. */
export function answerProposal(office: string, proposal: string, accept: boolean): Promise<unknown> {
  return post('/api/team', { office, proposal, accept });
}

/** A new office: a name and its project folder (absolute, not another office's). */
export async function createOffice(name: string, folder: string): Promise<OfficeInfo> {
  return (await post<{ office: OfficeInfo }>('/api/team', { createOffice: { name, folder } })).office;
}

export function renameOffice(office: string, name: string): Promise<unknown> {
  return post('/api/team', { office, rename: name });
}

/** Declares or changes the office's project folder. */
export function setOfficeFolder(office: string, folder: string): Promise<unknown> {
  return post('/api/team', { office, folder });
}

/** Deletes an office: its boss steps down and its running jobs are cancelled (the last office cannot go). */
export function deleteOffice(office: string): Promise<unknown> {
  return post('/api/team', { deleteOffice: office });
}

export interface AskRequest {
  worker: WorkerId;
  prompt: string;
  role?: string;
  mode?: string;
  effort?: string;
  /** OfficeInfo.id: the office giving the job (the worker must belong to it). */
  office?: string;
}

/** Gives a worker a job through its terminal (a fresh conversation); BUSY (a job runs) throws. */
export async function askWorker(req: AskRequest): Promise<WorkerJob> {
  return (await post<{ job: WorkerJob }>('/api/workers/ask', { ...req, by: 'you' })).job;
}

/** Cancels one job, every job of a worker, or all of them; returns how many. */
export async function cancelJobs(target: { job: string } | { worker: WorkerId } | { all: true }): Promise<number> {
  return (await post<{ cancelled?: number }>('/api/workers/cancel', target)).cancelled ?? 0;
}

// ---------------------------------------------------------------- pure helpers (workers-api.test.ts)

export function workerKind(worker: WorkerId): WorkerKind {
  return worker.startsWith('claude:') ? 'claude' : 'agy';
}

/** The terminal session of a worker's character (in any office: a worker has one character per office). */
export function sessionOfAgent(team: Pick<TeamInfo, 'sessions'> | undefined, agentId: string): WorkerSession | undefined {
  return team?.sessions?.find((s) => s.agentId === agentId || (!!s.agentIds && Object.values(s.agentIds).includes(agentId)));
}

/** The worker's character in that office (agentIds), else its first one (agentId; older server, or no office). */
export function sessionAgentIn(s: Pick<WorkerSession, 'agentId' | 'agentIds'>, office: string | undefined): string {
  return (office && s.agentIds?.[office]) || s.agentId;
}

/** Every character of a worker's session, one per office. */
export function sessionAgents(s: Pick<WorkerSession, 'agentId' | 'agentIds'>): string[] {
  return [...new Set([s.agentId, ...Object.values(s.agentIds ?? {})])];
}

export function sessionOf(team: Pick<TeamInfo, 'sessions'> | undefined, worker: WorkerId): WorkerSession | undefined {
  return team?.sessions?.find((s) => s.worker === worker);
}

/**
 * The registered worker behind a character: its terminal session, else (older server, no sessions) an Antigravity
 * worker "agy:accN" whose profile is in the team (any office). Without a team every Antigravity worker counts (as before teams).
 */
export function workerOfAgent(team: Pick<TeamInfo, 'workers' | 'sessions' | 'offices'> | undefined, a: Pick<AgentInfo, 'id' | 'provider'>): WorkerId | undefined {
  const s = sessionOfAgent(team, a.id);
  if (s) return s.worker;
  if (a.provider !== 'agy' || !a.id.startsWith('agy:')) return undefined;
  const acc = a.id.slice(4);
  return !team || team.workers.includes(acc) || !!team.offices?.some((o) => o.workers.includes(acc)) ? acc : undefined;
}

export interface WorkerChoice {
  /** The id choosing it gives: the account, or its next free session ("acc2#2") when it is already there or is the boss's. */
  worker: WorkerId;
  kind: WorkerKind;
  /** AccountInfo.id. */
  account: string;
  /** The session number of `worker`: 1 = the plain id; 2, 3… = one more session of the account. */
  n: number;
  /** The office's boss runs on this account (the boss is its first session). */
  own: boolean;
  /**
   * Which of the two kinds of "＋ Worker" this is: false = the account is not in the office yet (add an account);
   * true = it already has a session there, or is the boss's own (clone a session: one more session of it).
   */
  clone: boolean;
}

/**
 * What "＋ Worker" offers in an office, for every logged-in Antigravity and Claude account: the accounts not there yet
 * first (to add), then the ones that already are a worker there, or the boss's own (to clone: one more session of the
 * account, "#2", "#3"…). Not offered: an Antigravity account that is a boss anywhere (agy-ask knows that boss by its
 * profile). Workers of another office are offered too (workers are shared). Without `office`: the old single team
 * (root fields).
 */
export function workerChoices(
  team: Pick<TeamInfo, 'workers' | 'agy' | 'claude' | 'bossAccount' | 'offices'> | undefined,
  office?: Pick<OfficeInfo, 'workers' | 'bossAccount'>,
): WorkerChoice[] {
  if (!team) return [];
  const workers = office?.workers ?? team.workers;
  const boss = office ? office.bossAccount : team.bossAccount;
  const agyBosses = new Set((team.offices ?? []).filter((o) => o.bossKind === 'agy' && o.bossAccount).map((o) => o.bossAccount));
  const accounts = [
    ...team.agy.map((p) => ({ worker: p.acc, kind: 'agy' as const, account: p.account })),
    ...(team.claude ?? []).map((c) => ({ worker: c.worker, kind: 'claude' as const, account: c.account })),
  ];
  const out = accounts
    .filter((c) => c.account !== boss || c.kind === 'claude')
    .filter((c) => !(c.kind === 'agy' && agyBosses.has(c.account)))
    .map((c): WorkerChoice => {
      const own = c.account === boss;
      const worker = nextWorkerId(workers, c.worker, own);
      return { ...c, worker, n: splitWorker(worker).n, own, clone: own || workers.some((w) => workerBase(w) === c.worker) };
    });
  return [...out.filter((c) => !c.clone), ...out.filter((c) => c.clone)];
}

/**
 * The two kinds of "＋ Worker", apart: `add` = accounts that are not in the office yet, `clone` = accounts that already
 * are (or the boss's own), each joining as one more session.
 */
export function workerChoiceGroups(choices: readonly WorkerChoice[]): { add: WorkerChoice[]; clone: WorkerChoice[] } {
  return { add: choices.filter((c) => !c.clone), clone: choices.filter((c) => c.clone) };
}

/** A job still running or waiting (it can be cancelled). */
export function jobOpen(status: string): boolean {
  return status === 'queued' || status === 'working';
}
