// The team and the workers' terminals, from the page: POST /api/team (server/team.ts) and /api/workers/* (server/workers).
// A worker is an Antigravity profile ("acc2") or a Claude Code account ("claude:<account id>"); each registered worker
// has a standing terminal to watch. The boss gives jobs through agy-ask / claude-ask; here you give them too and cancel them.
// Errors become Error with the server's message (a BUSY answer's `message`, else `error`).
import type { AgentInfo, OfficeInfo, PtyInfo, TeamInfo, WorkerId, WorkerJob, WorkerKind, WorkerSession } from '../../../shared/types';
import type { OfficeRules } from '../../../shared/rules';
import { tr } from '../../../shared/i18n';

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
  worker: WorkerId;
  kind: WorkerKind;
  /** AccountInfo.id. */
  account: string;
}

/**
 * Accounts "＋ Worker" can register in an office: logged-in Antigravity and Claude accounts not already its workers nor
 * its boss's account, and no Antigravity account that is a boss anywhere (one agy per profile). Workers of another
 * office are offered too (workers are shared). Without `office`: the old single team (root fields).
 */
export function freeWorkers(
  team: Pick<TeamInfo, 'workers' | 'agy' | 'claude' | 'bossAccount' | 'offices'> | undefined,
  office?: Pick<OfficeInfo, 'workers' | 'bossAccount'>,
): WorkerChoice[] {
  if (!team) return [];
  const workers = office?.workers ?? team.workers;
  const boss = office ? office.bossAccount : team.bossAccount;
  const agyBosses = new Set((team.offices ?? []).filter((o) => o.bossKind === 'agy' && o.bossAccount).map((o) => o.bossAccount));
  const out: WorkerChoice[] = [
    ...team.agy.map((p) => ({ worker: p.acc, kind: 'agy' as const, account: p.account })),
    ...(team.claude ?? []).map((c) => ({ worker: c.worker, kind: 'claude' as const, account: c.account })),
  ];
  return out.filter((c) => !workers.includes(c.worker) && c.account !== boss && !(c.kind === 'agy' && agyBosses.has(c.account)));
}

/** A job still running or waiting (it can be cancelled). */
export function jobOpen(status: string): boolean {
  return status === 'queued' || status === 'working';
}
