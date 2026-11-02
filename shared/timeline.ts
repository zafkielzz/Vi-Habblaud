// Office timeline (timelapse): format of files saved by server
// (server/history/timeline.ts) and state reconstruction used by client player.
// Pure code: no Node or DOM APIs.
//
// File: <dataDir>/timeline/YYYY-MM-DD.jsonl (server local day), one JSON record per line:
//   {"t":"k",...}    keyframe: complete state (rooms, agents, and accounts);
//   {"t":"d",...}    delta: only what changed since previous record;
//   {"t":"end",...}  server stopped (or day reached file size limit).
// Every file starts with a keyframe and keyframes repeat every `every` ms; without any records
// for much longer than that, server was off. Each record begins with `t` and `at` (in that order),
// allowing fast reading of first and last timestamps without parsing whole file.
//
// Only includes fields used by world and UI to render, with activity summaries already
// masked (same exposure as /api/snapshot): no command details, tasks, or transcripts.
import type { AppearanceParts } from './appearance';
import type { AccountInfo, AccountUsage, Activity, ActivityKind, AgentInfo, AgentKind, AgentStatus, OfficeSnapshot, Provider, RoomInfo, ShellJob } from './types';

export const TIMELINE_VERSION = 1;

/** Long titles and texts are truncated (day file has a size limit). */
const MAX_TITLE = 160;
const MAX_TEXT = 120;

export interface TimelineActivity {
  kind: ActivityKind;
  icon: string;
  text: string;
  at: number;
  tool?: string;
  error?: true;
}

/** Summarized shell (without full command). */
export interface TimelineShell {
  id: string;
  label: string;
  startedAt: number;
  background: boolean;
  kind: 'shell' | 'monitor';
}

export interface TimelineAgent {
  id: string;
  kind: AgentKind;
  /** Absent = 'claude' (AgentInfo.provider). */
  provider?: Provider;
  parentId?: string;
  roomId: string;
  name: string;
  look: 'f' | 'm';
  role: string;
  account: string;
  status: AgentStatus;
  statusSince: number;
  startedAt: number;
  waitingFor?: string;
  activity?: TimelineActivity;
  seed: number;
  /** Edited character parts (see AgentInfo.parts). */
  parts?: AppearanceParts;
  background?: true;
  title?: string;
  shells?: TimelineShell[];
  /** Demo mode agent (id with "demo:" prefix): player can hide it. */
  demo?: true;
}

export interface TimelineRoom {
  id: string;
  name: string;
  path: string;
  slot: number;
  seed: number;
  createdAt: number;
  demo?: true;
}

/**
 * Summarized account: no email, organization, or directory; usage without
 * fetch time (would change on each response).
 */
export interface TimelineAccount {
  id: string;
  /** Absent = 'claude' (AccountInfo.provider). */
  provider?: Provider;
  short: string;
  name: string;
  color: string;
  plan?: string;
  sessions: number;
  usage?: Pick<AccountUsage, 'fiveHour' | 'sevenDay' | 'source' | 'noQuota' | 'noFiveHour'>;
  usageStatus: AccountInfo['usageStatus'];
  demo?: true;
}

export interface TimelineKeyframe {
  t: 'k';
  at: number;
  v: number;
  /** Active keyframe interval (ms). */
  every: number;
  /** First record after server startup. */
  boot?: true;
  rooms: TimelineRoom[];
  agents: TimelineAgent[];
  accounts: TimelineAccount[];
}

/** Changed fields; `null` = field no longer exists. */
export type TimelinePatch<T> = { [K in keyof T]?: T[K] | null };

/** Changes between two states. New agent is sent in full; `null` = departed. */
export interface TimelineChanges {
  rooms?: [string, TimelineRoom | null][];
  agents?: [string, TimelinePatch<TimelineAgent> | null][];
  accounts?: [string, TimelineAccount | null][];
}

export interface TimelineDelta extends TimelineChanges {
  t: 'd';
  at: number;
}

export interface TimelineEnd {
  t: 'end';
  at: number;
  /** 'limit' = day reached size limit and recording stopped until midnight rollover. */
  reason?: 'stop' | 'limit';
}

export type TimelineRecord = TimelineKeyframe | TimelineDelta | TimelineEnd;

/** Full state at a moment (what a keyframe describes). */
export interface TimelineFrame {
  rooms: Map<string, TimelineRoom>;
  agents: Map<string, TimelineAgent>;
  accounts: Map<string, TimelineAccount>;
}

// ------------------------------------------------------------------ days

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local day of a timestamp, in filename format (YYYY-MM-DD). */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD of a date that exists in the calendar (the only format accepted as filename). */
export function isDayKey(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Local midnight of day `key` (epoch ms). */
export function dayStart(key: string): number {
  const [y, mo, d] = key.split('-').map(Number);
  return new Date(y, mo - 1, d).getTime();
}

/** Day `offset` days before/after `key` (calendar arithmetic: unaffected by DST). */
export function shiftDay(key: string, offset: number): string {
  const [y, mo, d] = key.split('-').map(Number);
  return dayKey(new Date(y, mo - 1, d + offset, 12).getTime());
}

// ------------------------------------------------------------------ snapshot -> record

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function compactActivity(a: Activity): TimelineActivity {
  const out: TimelineActivity = { kind: a.kind, icon: a.icon, text: clip(a.text, MAX_TEXT), at: a.at };
  if (a.tool) out.tool = a.tool;
  if (a.error) out.error = true;
  return out;
}

export function compactShell(j: ShellJob): TimelineShell {
  return { id: j.id, label: clip(j.label, MAX_TEXT), startedAt: j.startedAt, background: j.background, kind: j.kind };
}

export function compactAgent(a: AgentInfo, demo = false): TimelineAgent {
  const out: TimelineAgent = {
    id: a.id,
    kind: a.kind,
    roomId: a.roomId,
    name: a.name,
    look: a.look,
    role: a.role,
    account: a.account,
    status: a.status,
    statusSince: a.statusSince,
    startedAt: a.startedAt,
    seed: a.seed,
  };
  if (a.provider) out.provider = a.provider;
  if (a.parentId) out.parentId = a.parentId;
  if (a.waitingFor) out.waitingFor = a.waitingFor;
  if (a.activity) out.activity = compactActivity(a.activity);
  if (a.background) out.background = true;
  if (a.parts && Object.keys(a.parts).length) out.parts = { ...a.parts };
  if (a.title) out.title = clip(a.title, MAX_TITLE);
  if (a.shells?.length) out.shells = a.shells.map(compactShell);
  if (demo) out.demo = true;
  return out;
}

export function compactRoom(r: RoomInfo, demo = false): TimelineRoom {
  const out: TimelineRoom = { id: r.id, name: r.name, path: r.path, slot: r.slot, seed: r.seed, createdAt: r.createdAt };
  if (demo) out.demo = true;
  return out;
}

export function compactAccount(a: AccountInfo, demo = false): TimelineAccount {
  const out: TimelineAccount = { id: a.id, short: a.short, name: a.name, color: a.color, sessions: a.sessions, usageStatus: a.usageStatus };
  if (a.provider) out.provider = a.provider;
  if (a.plan) out.plan = a.plan;
  if (a.usage) {
    const u: NonNullable<TimelineAccount['usage']> = { source: a.usage.source };
    if (a.usage.fiveHour) u.fiveHour = { ...a.usage.fiveHour };
    if (a.usage.sevenDay) u.sevenDay = { ...a.usage.sevenDay };
    if (a.usage.noQuota) u.noQuota = true;
    if (a.usage.noFiveHour) u.noFiveHour = true;
    out.usage = u;
  }
  if (demo) out.demo = true;
  return out;
}

/** Demo mode agents, rooms, and accounts use prefix "demo:" (see Office.setDemo). */
export const isDemoId = (id: string): boolean => id.startsWith('demo:');

export function compactSnapshot(snap: OfficeSnapshot, isDemo: (id: string) => boolean = isDemoId): TimelineFrame {
  return {
    rooms: new Map(snap.rooms.map((r) => [r.id, compactRoom(r, isDemo(r.id))])),
    agents: new Map(snap.agents.map((a) => [a.id, compactAgent(a, isDemo(a.id))])),
    accounts: new Map(snap.accounts.map((a) => [a.id, compactAccount(a, isDemo(a.id))])),
  };
}

export function keyframeOf(frame: TimelineFrame, at: number, every: number, boot = false): TimelineKeyframe {
  const k: TimelineKeyframe = {
    t: 'k',
    at,
    v: TIMELINE_VERSION,
    every,
    rooms: [...frame.rooms.values()],
    agents: [...frame.agents.values()],
    accounts: [...frame.accounts.values()],
  };
  if (boot) k.boot = true;
  return k;
}

export function frameOf(k: TimelineKeyframe): TimelineFrame {
  return {
    rooms: new Map(k.rooms.map((r) => [r.id, r])),
    agents: new Map(k.agents.map((a) => [a.id, a])),
    accounts: new Map(k.accounts.map((a) => [a.id, a])),
  };
}

export function emptyFrame(): TimelineFrame {
  return { rooms: new Map(), agents: new Map(), accounts: new Map() };
}

// ------------------------------------------------------------------ diffs

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function patchOf<T extends object>(prev: T, next: T): TimelinePatch<T> | null {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  let patch: Record<string, unknown> | null = null;
  for (const k of Object.keys(n)) if (!same(p[k], n[k])) (patch ??= {})[k] = n[k];
  for (const k of Object.keys(p)) if (!(k in n)) (patch ??= {})[k] = null;
  return patch as TimelinePatch<T> | null;
}

function diffWhole<T>(prev: Map<string, T>, next: Map<string, T>): [string, T | null][] {
  const out: [string, T | null][] = [];
  for (const [id, v] of next) if (!same(prev.get(id), v)) out.push([id, v]);
  for (const id of prev.keys()) if (!next.has(id)) out.push([id, null]);
  return out;
}

/** What changed from `prev` to `next` (null = nothing drawn by player). */
export function diffFrames(prev: TimelineFrame, next: TimelineFrame): TimelineChanges | null {
  const out: TimelineChanges = {};
  const rooms = diffWhole(prev.rooms, next.rooms);
  if (rooms.length) out.rooms = rooms;
  const agents: [string, TimelinePatch<TimelineAgent> | null][] = [];
  for (const [id, a] of next.agents) {
    const p = prev.agents.get(id);
    if (!p) agents.push([id, a]);
    else {
      const patch = patchOf(p, a);
      if (patch) agents.push([id, patch]);
    }
  }
  for (const id of prev.agents.keys()) if (!next.agents.has(id)) agents.push([id, null]);
  if (agents.length) out.agents = agents;
  const accounts = diffWhole(prev.accounts, next.accounts);
  if (accounts.length) out.accounts = accounts;
  return out.rooms || out.agents || out.accounts ? out : null;
}

const isFullAgent = (p: TimelinePatch<TimelineAgent>): p is TimelineAgent =>
  typeof p.id === 'string' && typeof p.roomId === 'string' && typeof p.name === 'string' && typeof p.status === 'string' && typeof p.seed === 'number';

/**
 * Applies changes (without mutating old objects: updated agents become new objects, preserving
 * snapshots already handed to UI). Patch for an unknown agent that is not full (dropped line in file)
 * is ignored: next keyframe corrects it.
 */
export function applyChanges(frame: TimelineFrame, d: TimelineChanges): void {
  for (const [id, r] of d.rooms ?? []) {
    if (r) frame.rooms.set(id, r);
    else frame.rooms.delete(id);
  }
  for (const [id, acc] of d.accounts ?? []) {
    if (acc) frame.accounts.set(id, acc);
    else frame.accounts.delete(id);
  }
  for (const [id, patch] of d.agents ?? []) {
    if (!patch) {
      frame.agents.delete(id);
      continue;
    }
    const cur = frame.agents.get(id);
    if (!cur) {
      if (isFullAgent(patch)) frame.agents.set(id, withoutNulls(patch) as TimelineAgent);
      continue;
    }
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    frame.agents.set(id, next as unknown as TimelineAgent);
  }
}

function withoutNulls<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = v;
  return out as T;
}

// ------------------------------------------------------------------ reading

/**
 * Parses day file content. Invalid lines (truncated, corrupted) are skipped;
 * backward clock jumps do not disorder records (time is clamped to previous record).
 */
export function parseTimeline(text: string): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  let last = -Infinity;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(rec)) continue;
    if (rec.at < last) rec.at = last;
    last = rec.at;
    out.push(rec);
  }
  return out;
}

function isRecord(r: unknown): r is TimelineRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return false;
  if (o.t === 'k') return Array.isArray(o.rooms) && Array.isArray(o.agents) && Array.isArray(o.accounts) && typeof o.every === 'number';
  if (o.t === 'd') return ['rooms', 'agents', 'accounts'].every((k) => o[k] === undefined || Array.isArray(o[k]));
  return o.t === 'end';
}

// ------------------------------------------------------------------ record -> snapshot

const ZERO_STATS = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };

/** Stable id for reconstructed activity (file does not store original id). */
export function activityId(agentId: string, a: Pick<TimelineActivity, 'at' | 'kind'>): string {
  return `tl:${agentId}:${a.at}:${a.kind}`;
}

export function toActivity(agentId: string, a: TimelineActivity): Activity {
  const out: Activity = { id: activityId(agentId, a), kind: a.kind, icon: a.icon, text: a.text, at: a.at };
  if (a.tool) out.tool = a.tool;
  if (a.error) out.error = true;
  return out;
}

/** Full AgentInfo from recorded summary (fields not stored in file remain empty). */
export function toAgentInfo(t: TimelineAgent, recent: Activity[] = []): AgentInfo {
  const activity = t.activity ? toActivity(t.id, t.activity) : undefined;
  const a: AgentInfo = {
    id: t.id,
    kind: t.kind,
    roomId: t.roomId,
    name: t.name,
    look: t.look,
    role: t.role,
    sessionId: t.id,
    account: t.account,
    status: t.status,
    recent: recent.length ? recent.slice() : activity ? [activity] : [],
    tasks: [],
    startedAt: t.startedAt,
    lastEventAt: Math.max(t.statusSince, activity?.at ?? 0),
    statusSince: t.statusSince,
    stats: { ...ZERO_STATS },
    seed: t.seed,
  };
  if (t.provider) a.provider = t.provider;
  if (t.parentId) a.parentId = t.parentId;
  if (t.title) a.title = t.title;
  if (t.waitingFor) a.waitingFor = t.waitingFor;
  if (activity) a.activity = activity;
  if (t.shells?.length) a.shells = t.shells.map((j) => ({ ...j }));
  if (t.background) a.background = true;
  if (t.parts) a.parts = { ...t.parts };
  return a;
}

export function toRoomInfo(r: TimelineRoom): RoomInfo {
  return { id: r.id, name: r.name, path: r.path, slot: r.slot, seed: r.seed, createdAt: r.createdAt };
}

export function toAccountInfo(a: TimelineAccount, at: number): AccountInfo {
  const out: AccountInfo = { id: a.id, short: a.short, name: a.name, color: a.color, configDir: '', sessions: a.sessions, usageStatus: a.usageStatus };
  if (a.provider) out.provider = a.provider;
  if (a.plan) out.plan = a.plan;
  if (a.usage) {
    const u: AccountUsage = { source: a.usage.source, fetchedAt: at };
    if (a.usage.fiveHour) u.fiveHour = { ...a.usage.fiveHour };
    if (a.usage.sevenDay) u.sevenDay = { ...a.usage.sevenDay };
    if (a.usage.noQuota) u.noQuota = true;
    if (a.usage.noFiveHour) u.noFiveHour = true;
    out.usage = u;
  }
  return out;
}
