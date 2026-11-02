// "Where did my day go": day stats (time per status, counts, tokens, cost, and waits).
// Pure code (no Node or DOM): the server aggregates and persists (server/history/daystats.ts), and the browser
// reuses the same logic in ?mock=1 (ui/daystats.ts). The GET /api/stats protocol also lives here.
//
// How it aggregates: on each sample (~1 s), the tracker (StatsTracker) inspects office agents and integrates, per
// agent, the time since previous sample in its current status, splitting interval at `statusSince` when status
// changed midway. Time falls into 1-hour buckets aligned in UTC (absolute timestamps), stored by "file day"
// (day in server timezone). The day displayed by the dashboard is only assembled upon query (queryDay), in the
// caller's timezone: Docker runs in UTC and the browser in user's timezone, and both agree on day start and end.
import type { AgentInfo, AgentStatus } from './types';
import { tr } from './i18n';

export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Sample interval above this is not integrated (frozen server, sleeping computer). */
export const MAX_GAP_MS = 120_000;
/**
 * Baseline: in first seconds of an existing agent (boot, resumed session), cumulative numbers only advance
 * the reference — reading the start of a long transcript arrives later and is not new usage.
 */
export const SETTLE_MS = 20_000;
/** Agents seen right at boot get a larger window (start-of-file reads are queued). */
export const BOOT_SETTLE_MS = 90_000;
/** Agent gone from the office: baseline is kept for this duration (if it returns, does not count again). */
export const KEEP_GONE_MS = 6 * HOUR_MS;
/** Wait shorter than this (registry flicker) is excluded from counts and rankings. */
export const MIN_WAIT_MS = 3_000;
/** Waits kept per file day (shortest are dropped first). */
export const MAX_WAITS_PER_DAY = 1_000;
/** Longest waits returned by query. */
export const TOP_WAITS = 10;
/** Days retained beyond today. */
export const RETENTION_DAYS = 30;
/**
 * Impossible jump in a sample (dozens of tools or millions of tokens in seconds): this is a re-read
 * (transcript start, rewritten file), not new usage — only shifts the baseline.
 */
const JUMP_WINDOW_MS = 10_000;
const JUMP_LIMITS = { toolCalls: 60, tokensIn: 5_000_000, tokensOut: 500_000, costUSD: 50 } as const;
/** Two waits from the same agent separated by less than this are merged into one. */
const WAIT_JOIN_MS = 1_500;

// ------------------------------------------------------------------ protocol (GET /api/stats)

/** Status with tracked time, in stack order (waiting on you first, near the base). */
export const TIMED_STATUSES = ['waiting', 'working', 'idle', 'shell'] as const;
export type TimedStatus = (typeof TIMED_STATUSES)[number];
/** Agent milliseconds in each status (two agents working 1 h = 2 h). */
export type StatusMs = Record<TimedStatus, number>;

export const COUNT_KEYS = ['prompts', 'toolCalls', 'tasksDone', 'tokensIn', 'tokensOut', 'costUSD'] as const;
export type CountKey = (typeof COUNT_KEYS)[number];
/** Summed counts (tokens and cost from cumulative metrics of each agent). */
export type StatsCounts = Record<CountKey, number>;

export interface StatsTotals {
  ms: StatusMs;
  counts: StatsCounts;
  /** Sessions (main agents; /clear opens a new one) with time in the day. */
  sessions: number;
  /** Subagents with time in the day. */
  subagents: number;
  /** Waits for you (episodes of at least MIN_WAIT_MS). */
  waits: number;
  longestWaitMs: number;
}

export interface RoomDayStats extends StatsTotals {
  /** = RoomInfo.id (project cwd). */
  id: string;
  name: string;
}

export interface AccountDayStats extends StatsTotals {
  /** = AccountInfo.id. */
  id: string;
  name: string;
  short: string;
  color: string;
}

export interface HourDayStats {
  /** Bucket start (epoch ms). */
  t: number;
  /** Local hour (0–23) in query timezone. */
  hour: number;
  ms: StatusMs;
}

export interface WaitDayStats {
  agentId: string;
  agentName: string;
  roomId: string;
  roomName: string;
  account: string;
  start: number;
  end: number;
  ms: number;
  /** Reason (e.g. "approve a permission"), when known. */
  reason?: string;
  /** Agent is still waiting now. */
  ongoing?: boolean;
}

export interface DayStats {
  /** YYYY-MM-DD in `tz` timezone. */
  day: string;
  tz: string;
  start: number;
  end: number;
  /** Last sample included in this day. */
  updatedAt?: number;
  totals: StatsTotals & {
    /** Wall-clock time with at least one agent waiting for you (not summing agents). */
    waitWallMs: number;
  };
  /** From most time waiting for you to least. */
  rooms: RoomDayStats[];
  /** From most work time to least. */
  accounts: AccountDayStats[];
  hours: HourDayStats[];
  /** Longest waits, from longest to shortest (at most TOP_WAITS). */
  waits: WaitDayStats[];
}

/** 'real' = real sessions (persisted); 'demo' = demo mode agents (fictional, in-memory only). */
export type StatsSource = 'real' | 'demo';

/** Response of GET /api/stats?day=YYYY-MM-DD&tz=<IANA>&source=real|demo */
export interface DayStatsResponse {
  source: StatsSource;
  /** Demo mode is active (source=demo can be requested). */
  demoAvailable: boolean;
  /** Today (YYYY-MM-DD) in query timezone. */
  today: string;
  serverTime: number;
  stats: DayStats;
}

/** Response of GET /api/stats/days?tz=<IANA> */
export interface StatsDaysResponse {
  tz: string;
  today: string;
  /** Days with real data (most recent first; today always appears). */
  days: string[];
  demoAvailable: boolean;
  /** Days with demo data (only when demo is active). */
  demoDays?: string[];
}

// ------------------------------------------------------------------ numbers

export function zeroMs(): StatusMs {
  return { waiting: 0, working: 0, idle: 0, shell: 0 };
}

export function zeroCounts(): StatsCounts {
  return { prompts: 0, toolCalls: 0, tasksDone: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
}

export function totalMs(ms: StatusMs): number {
  return ms.waiting + ms.working + ms.idle + ms.shell;
}

export function isTimedStatus(s: AgentStatus | string): s is TimedStatus {
  return s === 'waiting' || s === 'working' || s === 'idle' || s === 'shell';
}

function roundMs(ms: StatusMs): StatusMs {
  return { waiting: Math.round(ms.waiting), working: Math.round(ms.working), idle: Math.round(ms.idle), shell: Math.round(ms.shell) };
}

function addMsTo(target: StatusMs, src: StatusMs): void {
  for (const k of TIMED_STATUSES) target[k] += src[k];
}

function addCountsTo(target: StatsCounts, src: StatsCounts): void {
  for (const k of COUNT_KEYS) target[k] += src[k];
}

export function hourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/** Calls `cb` for each slice of [from, to) within an hour (UTC-aligned). */
export function forEachHour(from: number, to: number, cb: (hour: number, ms: number) => void): void {
  let s = from;
  while (s < to) {
    const hs = hourStart(s);
    const e = Math.min(to, hs + HOUR_MS);
    cb(hs, e - s);
    s = e;
  }
}

/** Merges overlapping intervals (for wall-clock time with someone waiting). */
export function mergeIntervals(list: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// ------------------------------------------------------------------ timezones and days

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Plausible IANA name ("America/Sao_Paulo", "UTC", "Etc/GMT+3"): Intl validates later. */
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Timezones cached (name comes from query string: case variations must not grow unbounded). */
const FMT_CACHE_MAX = 64;

function partsFormat(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    if (fmtCache.size >= FMT_CACHE_MAX) fmtCache.clear();
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function localParts(t: number, tz: string): LocalParts {
  const out: LocalParts = { y: 1970, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  for (const p of partsFormat(tz).formatToParts(t)) {
    const v = Number(p.value);
    if (p.type === 'year') out.y = v;
    else if (p.type === 'month') out.mo = v;
    else if (p.type === 'day') out.d = v;
    else if (p.type === 'hour') out.h = v % 24;
    else if (p.type === 'minute') out.mi = v;
    else if (p.type === 'second') out.s = v;
  }
  return out;
}

/** Canonical timezone name (e.g. "america/sao_paulo" -> "America/Sao_Paulo"), or null if Intl rejects it. */
export function canonicalTimeZone(tz: string): string | null {
  if (tz.length > 64 || !TZ_RE.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Timezone accepted by Intl (and formatted like an IANA name)? */
export function isValidTimeZone(tz: string): boolean {
  return canonicalTimeZone(tz) !== null;
}

/** Process timezone (in Docker, usually UTC). */
export function systemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of timestamp `t` in timezone `tz`. */
export function dayKeyOf(t: number, tz: string): string {
  const p = localParts(t, tz);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** Local hour (0–23) of timestamp `t` in timezone `tz`. */
export function localHourOf(t: number, tz: string): number {
  return localParts(t, tz).h;
}

/** Strictly validates "YYYY-MM-DD" (exact format and existing calendar date). */
export function parseDayKey(key: string): { y: number; m: number; d: number } | null {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Adds `n` calendar days to "YYYY-MM-DD". */
export function addDays(key: string, n: number): string {
  const k = parseDayKey(key);
  if (!k) return key;
  const d = new Date(Date.UTC(k.y, k.m - 1, k.d + n));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Local - UTC offset (ms) at timestamp `t`. */
function offsetMs(t: number, tz: string): number {
  const p = localParts(t, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** First moment of day `key` in timezone `tz` (midnight, or actual start on DST change days). */
export function dayStart(key: string, tz: string): number {
  const k = parseDayKey(key);
  if (!k) throw new RangeError(tr('invalid day: {0}', [key]));
  const guess = Date.UTC(k.y, k.m - 1, k.d);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz);
  // Nonexistent midnight (DST starting at 00:00): steps forward to the first moment of the day.
  const step = 15 * 60_000;
  for (let i = 0; i < 16 && dayKeyOf(t, tz) < key; i++) t += step;
  for (let i = 0; i < 16 && dayKeyOf(t - step, tz) === key; i++) t -= step;
  return t;
}

export function dayRange(key: string, tz: string): { start: number; end: number } {
  return { start: dayStart(key, tz), end: dayStart(addDays(key, 1), tz) };
}

/** Does the 1-hour bucket starting at `t` belong to [start, end)? (by hour midpoint: half-hour timezones) */
function hourInRange(t: number, start: number, end: number): boolean {
  const mid = t + HOUR_MS / 2;
  return mid >= start && mid < end;
}

// ------------------------------------------------------------------ file day (in memory)

export interface StatsPart {
  ms: StatusMs;
  counts: StatsCounts;
}

export interface HourBucket {
  /** Start of the hour (epoch ms, UTC-aligned). */
  t: number;
  ms: StatusMs;
  waitWallMs: number;
  counts: StatsCounts;
  rooms: Map<string, StatsPart>;
  accounts: Map<string, StatsPart>;
  /** Present during this hour: 'm:<sessionId>' (session) or 's:<id>' (subagent) -> [room, account]. */
  agents: Map<string, [string, string]>;
}

export interface AccountMeta {
  name: string;
  short: string;
  color: string;
}

/** Wait episode for you (continuous 'waiting' status of an agent). */
export interface WaitRecord {
  agentId: string;
  agentName: string;
  roomId: string;
  account: string;
  start: number;
  end: number;
  reason?: string;
  /** Still open on last sample (in a file loaded at boot: server stopped during wait). */
  open?: boolean;
}

function newBucket(t: number): HourBucket {
  return { t, ms: zeroMs(), waitWallMs: 0, counts: zeroCounts(), rooms: new Map(), accounts: new Map(), agents: new Map() };
}

function partOf(map: Map<string, StatsPart>, key: string): StatsPart {
  let p = map.get(key);
  if (!p) map.set(key, (p = { ms: zeroMs(), counts: zeroCounts() }));
  return p;
}

function bucketHasData(b: HourBucket): boolean {
  return totalMs(b.ms) > 0 || b.counts.prompts > 0 || b.counts.toolCalls > 0 || b.counts.tokensIn > 0 || b.counts.tokensOut > 0;
}

/** Data for a file day (day in server timezone): hour buckets, names, and waits. */
export class DayData {
  readonly hours = new Map<number, HourBucket>();
  /** Room -> display name. */
  readonly rooms = new Map<string, string>();
  readonly accounts = new Map<string, AccountMeta>();
  waits: WaitRecord[] = [];
  /** Changed since last write. */
  dirty = false;
  updatedAt = 0;

  constructor(readonly key: string) {}

  hour(t: number): HourBucket {
    let b = this.hours.get(t);
    if (!b) this.hours.set(t, (b = newBucket(t)));
    return b;
  }

  /** Hours with any data (for day index). */
  hoursWithData(): number[] {
    return [...this.hours.values()].filter(bucketHasData).map((b) => b.t);
  }

  toFile(): StatsDayFile {
    const parts = (m: Map<string, StatsPart>): Array<[string, StatsPart]> => [...m].map(([k, p]) => [k, { ms: { ...p.ms }, counts: { ...p.counts } }]);
    return {
      version: 1,
      day: this.key,
      updatedAt: this.updatedAt,
      hours: [...this.hours.values()]
        .sort((a, b) => a.t - b.t)
        .map((b) => ({
          t: b.t,
          ms: { ...b.ms },
          waitWallMs: b.waitWallMs,
          counts: { ...b.counts },
          rooms: parts(b.rooms),
          accounts: parts(b.accounts),
          agents: [...b.agents].map(([k, [r, a]]) => [k, r, a]),
        })),
      rooms: [...this.rooms],
      accounts: [...this.accounts].map(([id, m]) => [id, { ...m }]),
      waits: this.waits.map((w) => ({ ...w })),
    };
  }
}

/**
 * File format of `${dataDir}/stats/YYYY-MM-DD.json` (lists instead of objects:
 * arbitrary keys are data, never prototype).
 */
export interface StatsDayFile {
  version: 1;
  day: string;
  updatedAt: number;
  hours: Array<{
    t: number;
    ms: StatusMs;
    waitWallMs: number;
    counts: StatsCounts;
    rooms: Array<[string, StatsPart]>;
    accounts: Array<[string, StatsPart]>;
    agents: Array<[string, string, string]>;
  }>;
  rooms: Array<[string, string]>;
  accounts: Array<[string, AccountMeta]>;
  waits: WaitRecord[];
}

// Defensive read: file might be truncated, hand-edited, or from another version.
const LIMITS = { hours: 30, parts: 500, agents: 5_000, text: 512, name: 120 };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function text(v: unknown, max = LIMITS.text): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function msFrom(v: unknown): StatusMs {
  const o = obj(v) ?? {};
  return { waiting: num(o.waiting), working: num(o.working), idle: num(o.idle), shell: num(o.shell) };
}

function countsFrom(v: unknown): StatsCounts {
  const o = obj(v) ?? {};
  return {
    prompts: num(o.prompts),
    toolCalls: num(o.toolCalls),
    tasksDone: num(o.tasksDone),
    tokensIn: num(o.tokensIn),
    tokensOut: num(o.tokensOut),
    costUSD: num(o.costUSD),
  };
}

function partsFrom(v: unknown): Map<string, StatsPart> {
  const out = new Map<string, StatsPart>();
  if (!Array.isArray(v)) return out;
  for (const item of v.slice(0, LIMITS.parts)) {
    if (!Array.isArray(item)) continue;
    const key = text(item[0]);
    const p = obj(item[1]);
    if (key && p) out.set(key, { ms: msFrom(p.ms), counts: countsFrom(p.counts) });
  }
  return out;
}

/** Builds DayData from file JSON; null if unrecognizable. */
export function parseDayFile(raw: unknown, key: string): DayData | null {
  const o = obj(raw);
  if (!o || o.version !== 1 || !Array.isArray(o.hours)) return null;
  const d = new DayData(key);
  d.updatedAt = num(o.updatedAt);
  for (const h of o.hours.slice(0, LIMITS.hours)) {
    const ho = obj(h);
    if (!ho || typeof ho.t !== 'number' || !Number.isFinite(ho.t) || ho.t % HOUR_MS !== 0) continue;
    const b = newBucket(ho.t);
    b.ms = msFrom(ho.ms);
    b.waitWallMs = num(ho.waitWallMs);
    b.counts = countsFrom(ho.counts);
    b.rooms = partsFrom(ho.rooms);
    b.accounts = partsFrom(ho.accounts);
    if (Array.isArray(ho.agents)) {
      for (const a of ho.agents.slice(0, LIMITS.agents)) {
        if (!Array.isArray(a)) continue;
        const k = text(a[0]);
        if (k) b.agents.set(k, [text(a[1]) ?? '', text(a[2]) ?? '']);
      }
    }
    d.hours.set(b.t, b);
  }
  if (Array.isArray(o.rooms)) {
    for (const r of o.rooms.slice(0, LIMITS.parts)) {
      if (!Array.isArray(r)) continue;
      const id = text(r[0]);
      const name = text(r[1], LIMITS.name);
      if (id && name) d.rooms.set(id, name);
    }
  }
  if (Array.isArray(o.accounts)) {
    for (const a of o.accounts.slice(0, LIMITS.parts)) {
      if (!Array.isArray(a)) continue;
      const id = text(a[0]);
      const m = obj(a[1]);
      if (!id || !m) continue;
      const color = text(m.color, 32);
      d.accounts.set(id, {
        name: text(m.name, LIMITS.name) ?? id,
        short: text(m.short, 3) ?? '?',
        color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#8b98b3',
      });
    }
  }
  if (Array.isArray(o.waits)) {
    for (const w of o.waits.slice(0, MAX_WAITS_PER_DAY)) {
      const wo = obj(w);
      if (!wo) continue;
      const agentId = text(wo.agentId);
      const start = num(wo.start);
      const end = num(wo.end);
      if (!agentId || !start || end < start) continue;
      const rec: WaitRecord = {
        agentId,
        agentName: text(wo.agentName, LIMITS.name) ?? tr('Agent'),
        roomId: text(wo.roomId) ?? '',
        account: text(wo.account) ?? '',
        start,
        end,
      };
      const reason = text(wo.reason, LIMITS.name);
      if (reason) rec.reason = reason;
      if (wo.open === true) rec.open = true;
      d.waits.push(rec);
    }
  }
  return d;
}

// ------------------------------------------------------------------ book: all loaded days

/** How tracker references an agent when writing (presence key, room, and account with display names). */
export interface AgentRef {
  key: string;
  room: string;
  roomName: string;
  account: string;
  accountMeta?: AccountMeta;
}

/**
 * File days in memory. `fileDayOf` returns which file day an hour belongs to (server timezone);
 * `loader` (optional) fetches an unloaded day from disk.
 */
export class StatsBook {
  private readonly days = new Map<string, DayData>();
  private readonly idx = new Map<number, { day: DayData; b: HourBucket }>();

  constructor(
    readonly fileDayOf: (t: number) => string,
    private readonly loader?: (key: string) => DayData | null,
  ) {}

  /** File day `key`: in memory, from disk (first time), or newly created. */
  day(key: string): DayData {
    let d = this.days.get(key);
    if (!d) {
      d = this.loader?.(key) ?? new DayData(key);
      this.days.set(key, d);
      for (const b of d.hours.values()) this.idx.set(b.t, { day: d, b });
    }
    return d;
  }

  peek(key: string): DayData | undefined {
    return this.days.get(key);
  }

  list(): DayData[] {
    return [...this.days.values()];
  }

  /** Evicts days before `key` from memory if already saved. */
  evictBefore(key: string): void {
    for (const [k, d] of this.days) {
      if (k >= key || d.dirty) continue;
      this.days.delete(k);
      for (const t of d.hours.keys()) this.idx.delete(t);
    }
  }

  private slot(t: number): { day: DayData; b: HourBucket } {
    const hs = hourStart(t);
    let s = this.idx.get(hs);
    if (!s) {
      const day = this.day(this.fileDayOf(hs));
      s = { day, b: day.hour(hs) };
      this.idx.set(hs, s);
    }
    return s;
  }

  private touch(day: DayData, at: number): void {
    day.dirty = true;
    if (at > day.updatedAt) day.updatedAt = at;
  }

  private note(day: DayData, ref: AgentRef): void {
    if (ref.roomName && day.rooms.get(ref.room) !== ref.roomName) day.rooms.set(ref.room, ref.roomName);
    const m = ref.accountMeta;
    const cur = day.accounts.get(ref.account);
    if (m && (!cur || cur.name !== m.name || cur.short !== m.short || cur.color !== m.color)) day.accounts.set(ref.account, { ...m });
  }

  /** Adds `ms` of `status` to hour starting at `hour` (without splitting: demo uses to build whole hours). */
  addMsAt(ref: AgentRef, status: TimedStatus, hour: number, ms: number, at = hour): void {
    if (!(ms > 0)) return;
    const { day, b } = this.slot(hour);
    b.ms[status] += ms;
    partOf(b.rooms, ref.room).ms[status] += ms;
    partOf(b.accounts, ref.account).ms[status] += ms;
    if (!b.agents.has(ref.key)) b.agents.set(ref.key, [ref.room, ref.account]);
    this.note(day, ref);
    this.touch(day, at);
  }

  /** Records agent presence during hour of `at` (day sessions and subagents), without elapsed time. */
  markPresent(ref: AgentRef, at: number): void {
    const { day, b } = this.slot(at);
    if (b.agents.has(ref.key)) return;
    b.agents.set(ref.key, [ref.room, ref.account]);
    this.note(day, ref);
    this.touch(day, at);
  }

  /** Adds interval [from, to) in `status`, partitioned across hours. */
  addTime(ref: AgentRef, status: TimedStatus, from: number, to: number): void {
    forEachHour(from, to, (hs, ms) => this.addMsAt(ref, status, hs, ms, to));
  }

  addCount(ref: AgentRef, key: CountKey, n: number, at: number): void {
    if (!(n > 0)) return;
    const { day, b } = this.slot(at);
    b.counts[key] += n;
    partOf(b.rooms, ref.room).counts[key] += n;
    partOf(b.accounts, ref.account).counts[key] += n;
    this.note(day, ref);
    this.touch(day, at);
  }

  addWaitWallAt(hour: number, ms: number, at = hour): void {
    if (!(ms > 0)) return;
    const { day, b } = this.slot(hour);
    b.waitWallMs += ms;
    this.touch(day, at);
  }

  addWaitWall(from: number, to: number): void {
    forEachHour(from, to, (hs, ms) => this.addWaitWallAt(hs, ms, to));
  }

  /** Stores a wait episode under the day it started. */
  addWait(rec: WaitRecord): void {
    const { day } = this.slot(rec.start);
    day.waits.push(rec);
    if (day.waits.length > MAX_WAITS_PER_DAY) {
      // Full: evict shortest closed wait.
      const length = (i: number) => day.waits[i].end - day.waits[i].start;
      let worst = -1;
      day.waits.forEach((w, i) => {
        if (w.open || w === rec) return;
        if (worst < 0 || length(i) < length(worst)) worst = i;
      });
      // No closed waits to evict (all still open): drop shortest of all, keeping limit enforced.
      if (worst < 0) {
        for (let i = 0; i < day.waits.length; i++) if (worst < 0 || length(i) < length(worst)) worst = i;
      }
      day.waits.splice(worst, 1);
    }
    this.touch(day, rec.end);
  }

  touchWait(rec: WaitRecord): void {
    this.touch(this.slot(rec.start).day, rec.end);
  }

  removeWait(rec: WaitRecord): void {
    const { day } = this.slot(rec.start);
    const i = day.waits.indexOf(rec);
    if (i >= 0) {
      day.waits.splice(i, 1);
      this.touch(day, rec.end);
    }
  }

  /** Still-open wait for `agentId` originating before a restart (ended after `since`). */
  findOpenWait(agentId: string, since: number): WaitRecord | undefined {
    for (const d of this.days.values()) {
      for (let i = d.waits.length - 1; i >= 0; i--) {
        const w = d.waits[i];
        if (w.open && w.agentId === agentId && w.end >= since) return w;
      }
    }
    return undefined;
  }
}

// ------------------------------------------------------------------ query: the day in caller's timezone

interface Agg extends StatsTotals {
  agents: Set<string>;
}

function newAgg(): Agg {
  return { ms: zeroMs(), counts: zeroCounts(), sessions: 0, subagents: 0, waits: 0, longestWaitMs: 0, agents: new Set() };
}

function finishAgg(a: Agg): StatsTotals {
  let sessions = 0;
  let subagents = 0;
  for (const k of a.agents) {
    if (k.startsWith('m:')) sessions++;
    else if (k.startsWith('s:')) subagents++;
  }
  const counts = { ...a.counts, costUSD: Math.round(a.counts.costUSD * 10_000) / 10_000 };
  return { ms: roundMs(a.ms), counts, sessions, subagents, waits: a.waits, longestWaitMs: Math.round(a.longestWaitMs) };
}

function aggOf(map: Map<string, Agg>, key: string): Agg {
  let a = map.get(key);
  if (!a) map.set(key, (a = newAgg()));
  return a;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Builds day `dayKey` (in `tz` timezone) from covering file days (include previous day as well,
 * for waits that started yesterday and crossed into today).
 */
export function queryDay(datas: readonly DayData[], dayKey: string, tz: string, now: number, opts: { top?: number } = {}): DayStats {
  const { start, end } = dayRange(dayKey, tz);
  const sorted = [...datas].sort((a, b) => a.key.localeCompare(b.key));
  const roomNames = new Map<string, string>();
  const accMeta = new Map<string, AccountMeta>();
  const hours = new Map<number, HourBucket>();
  let updatedAt = 0;
  for (const d of sorted) {
    for (const [id, n] of d.rooms) roomNames.set(id, n);
    for (const [id, m] of d.accounts) accMeta.set(id, m);
    for (const [t, b] of d.hours) if (hourInRange(t, start, end)) hours.set(t, b);
  }

  const total = newAgg();
  let waitWallMs = 0;
  const rooms = new Map<string, Agg>();
  const accounts = new Map<string, Agg>();
  for (const b of hours.values()) {
    addMsTo(total.ms, b.ms);
    addCountsTo(total.counts, b.counts);
    waitWallMs += b.waitWallMs;
    for (const [id, p] of b.rooms) {
      const a = aggOf(rooms, id);
      addMsTo(a.ms, p.ms);
      addCountsTo(a.counts, p.counts);
    }
    for (const [id, p] of b.accounts) {
      const a = aggOf(accounts, id);
      addMsTo(a.ms, p.ms);
      addCountsTo(a.counts, p.counts);
    }
    for (const [k, [room, acc]] of b.agents) {
      total.agents.add(k);
      aggOf(rooms, room).agents.add(k);
      aggOf(accounts, acc).agents.add(k);
    }
    for (const d of sorted) if (d.hours.get(b.t) === b && d.updatedAt > updatedAt) updatedAt = d.updatedAt;
  }

  // Waits touching this day (one crossing midnight appears in both days with full duration).
  const seen = new Set<string>();
  const waits: WaitRecord[] = [];
  for (const d of sorted) {
    for (const w of d.waits) {
      if (w.end <= start || w.start >= end || w.end - w.start < MIN_WAIT_MS) continue;
      const key = `${w.agentId}|${w.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      waits.push(w);
    }
  }
  for (const w of waits) {
    const ms = w.end - w.start;
    for (const a of [total, aggOf(rooms, w.roomId), aggOf(accounts, w.account)]) {
      a.waits++;
      if (ms > a.longestWaitMs) a.longestWaitMs = ms;
    }
  }
  const top = [...waits].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start).slice(0, opts.top ?? TOP_WAITS);

  const hourList: HourDayStats[] = [];
  for (let t = hourStart(start); t < end; t += HOUR_MS) {
    if (!hourInRange(t, start, end)) continue;
    hourList.push({ t, hour: localHourOf(Math.max(t, start), tz), ms: roundMs(hours.get(t)?.ms ?? zeroMs()) });
  }

  const roomName = (id: string) => roomNames.get(id) ?? basename(id);
  const roomList: RoomDayStats[] = [...rooms]
    .map(([id, a]) => ({ id, name: roomName(id), ...finishAgg(a) }))
    .sort((a, b) => b.ms.waiting - a.ms.waiting || totalMs(b.ms) - totalMs(a.ms) || a.name.localeCompare(b.name));
  const accountList: AccountDayStats[] = [...accounts]
    .map(([id, a]) => {
      const m = accMeta.get(id);
      return { id, name: m?.name ?? id, short: m?.short ?? '?', color: m?.color ?? '#8b98b3', ...finishAgg(a) };
    })
    .sort((a, b) => b.ms.working - a.ms.working || totalMs(b.ms) - totalMs(a.ms) || a.name.localeCompare(b.name));

  const out: DayStats = {
    day: dayKey,
    tz,
    start,
    end,
    totals: { ...finishAgg(total), waitWallMs: Math.round(waitWallMs) },
    rooms: roomList,
    accounts: accountList,
    hours: hourList,
    waits: top.map((w) => {
      const item: WaitDayStats = {
        agentId: w.agentId,
        agentName: w.agentName,
        roomId: w.roomId,
        roomName: roomName(w.roomId),
        account: w.account,
        start: w.start,
        end: w.end,
        ms: w.end - w.start,
      };
      if (w.reason) item.reason = w.reason;
      if (w.open && now - w.end < 10_000) item.ongoing = true;
      return item;
    }),
  };
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/** Days (in `tz` timezone) with any data, derived from hours with data in each file day. */
export function daysFromHours(hours: Iterable<number>, tz: string): Set<string> {
  const out = new Set<string>();
  for (const t of hours) out.add(dayKeyOf(t + HOUR_MS / 2, tz));
  return out;
}

/** File days (`fileTz` timezone) covering [from, to). */
export function fileDaysCovering(from: number, to: number, fileTz: string): string[] {
  const out = new Set<string>();
  for (let t = from; t < to; t += 6 * HOUR_MS) out.add(dayKeyOf(t, fileTz));
  out.add(dayKeyOf(Math.max(from, to - 1), fileTz));
  return [...out].sort();
}

/** For `dayKey` query: file days of day itself and preceding day (for waits crossing midnight). */
export function fileDaysForQuery(dayKey: string, tz: string, fileTz: string): string[] {
  const { start, end } = dayRange(dayKey, tz);
  return fileDaysCovering(start - DAY_MS, end, fileTz);
}

// ------------------------------------------------------------------ tracker

/** What tracker observes: agents and room/account display names (an OfficeSnapshot works). */
export interface StatsView {
  agents: readonly AgentInfo[];
  rooms: readonly { id: string; name: string }[];
  accounts: readonly { id: string; name: string; short: string; color: string }[];
}

export interface TrackerOptions {
  /** Start of observation (epoch ms): prompts prior to this (transcript re-read on boot) do not count. */
  startedAt: number;
}

interface Baseline {
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUSD: number;
}

interface Track {
  sessionId: string;
  status: AgentStatus;
  lastAt: number;
  seenAt: number;
  /** Highest seen value for each cumulative count (only increases beyond this count as new usage). */
  hw: Baseline;
  costKnown: boolean;
  /** Counts from zero (agent created after observation started). */
  fresh: boolean;
  tasksDone: number;
  settleUntil: number;
  /** Already counted prompts (activity ids). */
  prompts: string[];
  wait?: WaitRecord;
}

function baselineOf(a: AgentInfo): Baseline {
  const s = a.stats;
  return { toolCalls: num(s.toolCalls), tokensIn: num(s.tokensIn), tokensOut: num(s.tokensOut), costUSD: num(s.costUSD) };
}

function maxBaseline(a: Baseline, b: Baseline): Baseline {
  return {
    toolCalls: Math.max(a.toolCalls, b.toolCalls),
    tokensIn: Math.max(a.tokensIn, b.tokensIn),
    tokensOut: Math.max(a.tokensOut, b.tokensOut),
    costUSD: Math.max(a.costUSD, b.costUSD),
  };
}

const ZERO_BASELINE: Baseline = { toolCalls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };

function isEmpty(b: Baseline): boolean {
  return b.toolCalls === 0 && b.tokensIn === 0 && b.tokensOut === 0;
}

function completedTasks(a: AgentInfo): number {
  return a.tasks.reduce((n, t) => n + (t.status === 'completed' ? 1 : 0), 0);
}

/**
 * Integrates each agent's time per status and accumulates counts (deltas from cumulative `AgentInfo.stats`,
 * prompts, and completed tasks), recording all into a StatsBook. Call observe() every ~1 s.
 */
export class StatsTracker {
  private readonly tracks = new Map<string, Track>();
  private lastSample: number | undefined;
  readonly startedAt: number;

  constructor(
    readonly book: StatsBook,
    opts: TrackerOptions,
  ) {
    this.startedAt = opts.startedAt;
  }

  /** Tracked agents (including recently departed ones). For tests. */
  get size(): number {
    return this.tracks.size;
  }

  observe(view: StatsView, now: number): void {
    const dt = this.lastSample === undefined ? Infinity : now - this.lastSample;
    this.lastSample = now;
    const roomNames = new Map(view.rooms.map((r) => [r.id, r.name]));
    const accounts = new Map(view.accounts.map((a) => [a.id, { name: a.name, short: a.short, color: a.color }]));
    const waiting: Array<[number, number]> = [];
    const present = new Set<string>();
    for (const a of view.agents) {
      present.add(a.id);
      const ref: AgentRef = {
        key: a.kind === 'main' ? `m:${a.sessionId}` : `s:${a.id}`,
        room: a.roomId,
        roomName: roomNames.get(a.roomId) ?? basename(a.roomId),
        account: a.account,
      };
      const meta = accounts.get(a.account);
      if (meta) ref.accountMeta = meta;
      let t = this.tracks.get(a.id);
      let sampleDt = dt;
      if (!t) {
        t = this.begin(a, now);
        this.tracks.set(a.id, t);
        // First time: initial numbers are suspected re-reads (jump limit applies).
        sampleDt = 0;
        // Mark present immediately (a fast subagent could complete before next sample).
        if (isTimedStatus(a.status) || t.fresh) this.book.markPresent(ref, now);
      } else {
        this.integrate(t, a, ref, now, waiting);
      }
      t.seenAt = now;
      t.status = a.status;
      this.countPrompts(t, a, ref, now);
      this.countDeltas(t, a, ref, now, sampleDt);
    }
    for (const [id, t] of this.tracks) {
      if (present.has(id)) continue;
      // Disappeared (grace period ended, registry rewritten...). If it returns shortly, resumes where it left off
      // (wait remains continuous); baseline is kept for longer.
      if (now - t.seenAt > MAX_GAP_MS) this.closeWait(t);
      if (now - t.seenAt > KEEP_GONE_MS) this.tracks.delete(id);
    }
    for (const [s, e] of mergeIntervals(waiting)) this.book.addWaitWall(s, e);
  }

  private begin(a: AgentInfo, now: number): Track {
    const cur = baselineOf(a);
    // Subagent spawned after observation start, or new session (no metrics yet): count from zero.
    const fresh = a.startedAt >= this.startedAt && (a.kind === 'sub' || isEmpty(cur));
    return {
      sessionId: a.sessionId,
      status: a.status,
      lastAt: now,
      seenAt: now,
      hw: fresh ? { ...ZERO_BASELINE } : cur,
      costKnown: fresh || a.stats.costUSD !== undefined,
      fresh,
      tasksDone: fresh ? 0 : completedTasks(a),
      settleUntil: fresh ? 0 : now + Math.max(SETTLE_MS, this.startedAt + BOOT_SETTLE_MS - now),
      prompts: [],
    };
  }

  private integrate(t: Track, a: AgentInfo, ref: AgentRef, now: number, waiting: Array<[number, number]>): void {
    const from = t.lastAt;
    t.lastAt = now;
    if (now <= from) return;
    if (now - from > MAX_GAP_MS) {
      // Long pause (server stopped, computer sleeping): interval does not count and wait restarts.
      this.closeWait(t);
      return;
    }
    const split = a.statusSince > from && a.statusSince < now ? a.statusSince : undefined;
    if (split !== undefined && t.status !== a.status) {
      this.segment(t, a, ref, t.status, from, split, waiting);
      this.segment(t, a, ref, a.status, split, now, waiting);
    } else {
      this.segment(t, a, ref, a.status, from, now, waiting);
    }
  }

  private segment(t: Track, a: AgentInfo, ref: AgentRef, status: AgentStatus, s: number, e: number, waiting: Array<[number, number]>): void {
    if (e <= s) return;
    if (!isTimedStatus(status)) {
      this.closeWait(t);
      return;
    }
    this.book.addTime(ref, status, s, e);
    if (status !== 'waiting') {
      this.closeWait(t);
      return;
    }
    waiting.push([s, e]);
    if (t.wait && s - t.wait.end <= WAIT_JOIN_MS) {
      t.wait.end = e;
      this.book.touchWait(t.wait);
      return;
    }
    this.closeWait(t);
    // Wait already open before a server restart: continues the same.
    const prev = this.book.findOpenWait(a.id, s - MAX_GAP_MS);
    if (prev) {
      prev.end = e;
      this.book.touchWait(prev);
      t.wait = prev;
      return;
    }
    const rec: WaitRecord = { agentId: a.id, agentName: a.name, roomId: a.roomId, account: a.account, start: s, end: e, open: true };
    if (a.waitingFor) rec.reason = a.waitingFor;
    this.book.addWait(rec);
    t.wait = rec;
  }

  private closeWait(t: Track): void {
    const w = t.wait;
    if (!w) return;
    t.wait = undefined;
    delete w.open;
    if (w.end - w.start < MIN_WAIT_MS) this.book.removeWait(w);
    else this.book.touchWait(w);
  }

  private countPrompts(t: Track, a: AgentInfo, ref: AgentRef, now: number): void {
    for (const act of a.recent) {
      if (act.kind !== 'prompt' || act.at < this.startedAt || t.prompts.includes(act.id)) continue;
      t.prompts.push(act.id);
      if (t.prompts.length > 64) t.prompts.shift();
      this.book.addCount(ref, 'prompts', 1, Math.min(act.at, now));
    }
  }

  private countDeltas(t: Track, a: AgentInfo, ref: AgentRef, now: number, dt: number): void {
    const cur = baselineOf(a);
    const done = completedTasks(a);
    if (a.sessionId !== t.sessionId) {
      // /clear (new, empty transcript) or /resume (old transcript with existing counts) in same process.
      t.sessionId = a.sessionId;
      t.fresh = isEmpty(cur);
      t.hw = t.fresh ? { ...ZERO_BASELINE } : cur;
      t.costKnown = t.fresh || a.stats.costUSD !== undefined;
      t.tasksDone = t.fresh ? 0 : done;
      t.settleUntil = t.fresh ? 0 : now + SETTLE_MS;
      t.prompts = [];
      return;
    }
    if (a.stats.costUSD !== undefined && !t.costKnown) {
      // Cost appeared just now: for an existing agent, this is session total so far, not new spend.
      t.costKnown = true;
      if (!t.fresh) t.hw.costUSD = Math.max(t.hw.costUSD, cur.costUSD);
    }
    if (now < t.settleUntil) {
      t.hw = maxBaseline(t.hw, cur);
      t.tasksDone = done;
      return;
    }
    const d: Baseline = {
      toolCalls: Math.max(0, cur.toolCalls - t.hw.toolCalls),
      tokensIn: Math.max(0, cur.tokensIn - t.hw.tokensIn),
      tokensOut: Math.max(0, cur.tokensOut - t.hw.tokensOut),
      costUSD: Math.max(0, cur.costUSD - t.hw.costUSD),
    };
    t.hw = maxBaseline(t.hw, cur);
    const jump =
      d.toolCalls > JUMP_LIMITS.toolCalls || d.tokensIn > JUMP_LIMITS.tokensIn || d.tokensOut > JUMP_LIMITS.tokensOut || d.costUSD > JUMP_LIMITS.costUSD;
    if (dt <= JUMP_WINDOW_MS && jump) {
      t.tasksDone = done;
      return;
    }
    this.book.addCount(ref, 'toolCalls', d.toolCalls, now);
    this.book.addCount(ref, 'tokensIn', d.tokensIn, now);
    this.book.addCount(ref, 'tokensOut', d.tokensOut, now);
    this.book.addCount(ref, 'costUSD', d.costUSD, now);
    // Tasks: list is replaced periodically (TodoWrite), so only increments count.
    if (done > t.tasksDone) this.book.addCount(ref, 'tasksDone', done - t.tasksDone, now);
    t.tasksDone = done;
  }
}
