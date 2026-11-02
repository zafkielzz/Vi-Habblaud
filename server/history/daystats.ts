// "Where did my day go": samples office every second, accumulates stats (shared/daystats.ts), and
// persists them in ${dataDir}/stats/YYYY-MM-DD.json (one file per day in server timezone), every 30 s and on
// exit. On boot reloads recent files (day survives restarts), deletes files older than 30 days, and
// builds an index of hours with data. Disk errors only produce a log warning: server never crashes because of this.
//
// Demo agents (prefix "demo:") never enter real data: when demo is enabled, they feed a separate,
// in-memory-only bucket seeded with fictional history (shared/demo/daystats.ts) for dashboard and screenshots.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import {
  addDays,
  dayKeyOf,
  daysFromHours,
  DayData,
  fileDaysForQuery,
  parseDayFile,
  queryDay,
  RETENTION_DAYS,
  StatsBook,
  StatsTracker,
  systemTimeZone,
  type DayStatsResponse,
  type StatsDaysResponse,
  type StatsSource,
  type StatsView,
} from '../../shared/daystats';
import { seedDemoHistory } from '../../shared/demo/daystats';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

/** Demo agent ID prefix on the server (see Office.setDemo). */
export const DEMO_ID_PREFIX = 'demo:';
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export interface DayStatsDeps {
  /** Files directory (`${dataDir}/stats`); null = memory only (tests). */
  dir: string | null;
  /** Current office state (real and demo agents, rooms, and accounts). */
  snapshot: () => Pick<OfficeSnapshot, 'agents' | 'rooms' | 'accounts' | 'meta'>;
  now?: () => number;
  /** Timezone for files and day rollover (default: process timezone; in Docker, UTC). */
  tz?: string;
  sampleMs?: number;
  flushMs?: number;
}

export class DayStatsService {
  readonly tz: string;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly book: StatsBook;
  private readonly tracker: StatsTracker;
  private demo: { book: StatsBook; tracker: StatsTracker } | null = null;
  /** Hours with data for each disk file (to list days without opening all). */
  private readonly index = new Map<string, number[]>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private retentionDay = '';

  constructor(private readonly deps: DayStatsDeps) {
    this.now = deps.now ?? Date.now;
    this.tz = deps.tz ?? systemTimeZone();
    this.startedAt = this.now();
    this.book = new StatsBook(
      (t) => dayKeyOf(t, this.tz),
      (key) => this.readDay(key),
    );
    this.tracker = new StatsTracker(this.book, { startedAt: this.startedAt });
  }

  /** Boot: removes data past retention, indexes files, and loads yesterday and today into memory. */
  load(): void {
    const today = this.today();
    this.cleanup(today);
    if (this.deps.dir) {
      for (const name of this.listFiles()) {
        const key = FILE_RE.exec(name)![1];
        const d = this.readDay(key);
        if (d) this.index.set(key, d.hoursWithData());
      }
    }
    this.book.day(addDays(today, -1));
    this.book.day(today);
  }

  start(): void {
    this.sampleTimer = setInterval(() => this.safely('sample', () => this.sample()), this.deps.sampleMs ?? 1_000);
    this.flushTimer = setInterval(() => this.safely('flush', () => this.flush()), this.deps.flushMs ?? 30_000);
    this.sampleTimer.unref?.();
    this.flushTimer.unref?.();
  }

  /** Stops timers, takes last sample, and flushes (call before stopping hub). */
  stop(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.sampleTimer = null;
    this.flushTimer = null;
    this.safely('sample', () => this.sample());
    this.flush();
  }

  /** An office sample (timer calls every second). */
  sample(now = this.now()): void {
    const snap = this.deps.snapshot();
    const realAgents: AgentInfo[] = [];
    const demoAgents: AgentInfo[] = [];
    // Demo = id and account with simulator prefix (an account directory named "demo" is not demo).
    for (const a of snap.agents) (a.id.startsWith(DEMO_ID_PREFIX) && a.account.startsWith(DEMO_ID_PREFIX) ? demoAgents : realAgents).push(a);
    const real: StatsView = { agents: realAgents, rooms: snap.rooms, accounts: snap.accounts };
    const demo: StatsView = { agents: demoAgents, rooms: snap.rooms, accounts: snap.accounts };
    this.tracker.observe(real, now);
    if (snap.meta.demo) {
      if (!this.demo) {
        const book = new StatsBook((t) => dayKeyOf(t, this.tz));
        seedDemoHistory(book, { ...demo, accounts: snap.accounts.filter((a) => a.id.startsWith(DEMO_ID_PREFIX)) }, now, this.tz);
        this.demo = { book, tracker: new StatsTracker(book, { startedAt: now }) };
      }
      this.demo.tracker.observe(demo, now);
    } else {
      this.demo = null;
    }
  }

  /** Flushes dirty days, applies retention at day rollover, and evicts old days from memory. */
  flush(): void {
    const today = this.today();
    if (today !== this.retentionDay) this.cleanup(today);
    for (const d of this.book.list()) {
      if (!d.dirty) continue;
      if (this.writeDay(d)) {
        d.dirty = false;
        this.index.set(d.key, d.hoursWithData());
      }
    }
    // Without disk, nothing is evicted from memory (dirty data stays until written).
    this.book.evictBefore(addDays(today, -1));
    this.demo?.book.evictBefore(addDays(today, -1));
  }

  isDemo(): boolean {
    return this.demo !== null;
  }

  /** Today in timezone `tz`. */
  today(tz = this.tz): string {
    return dayKeyOf(this.now(), tz);
  }

  /** Days with data (in timezone `tz`), newest to oldest, within retention. */
  days(tz: string): StatsDaysResponse {
    const today = this.today(tz);
    const oldest = addDays(today, -RETENTION_DAYS);
    const real = new Set<string>();
    for (const [key, hours] of this.index) if (!this.book.peek(key)) for (const d of daysFromHours(hours, tz)) real.add(d);
    for (const d of this.book.list()) for (const k of daysFromHours(d.hoursWithData(), tz)) real.add(k);
    real.add(today);
    const list = (set: Set<string>) => [...set].filter((d) => d >= oldest && d <= today).sort().reverse();
    const out: StatsDaysResponse = { tz, today, days: list(real), demoAvailable: this.demo !== null };
    if (this.demo) {
      const demoDays = new Set([today]);
      for (const d of this.demo.book.list()) for (const k of daysFromHours(d.hoursWithData(), tz)) demoDays.add(k);
      out.demoDays = list(demoDays);
    }
    return out;
  }

  /**
   * Stats for day `day` (timezone `tz`). Missing `source`: demo when enabled and day is today,
   * otherwise real data. null = no data for this day (or requested demo is disabled).
   */
  day(day: string, tz: string, source?: StatsSource): DayStatsResponse | null {
    const now = this.now();
    const today = this.today(tz);
    const src: StatsSource = source ?? (this.demo && day === today ? 'demo' : 'real');
    if (src === 'demo' && !this.demo) return null;
    const known = src === 'demo' ? this.days(tz).demoDays ?? [] : this.days(tz).days;
    if (day !== today && !known.includes(day)) return null;
    const book = src === 'demo' ? this.demo!.book : this.book;
    const datas: DayData[] = [];
    for (const key of fileDaysForQuery(day, tz, this.tz)) {
      const d = book.peek(key) ?? (src === 'real' && this.index.has(key) ? this.readDay(key) : null);
      if (d) datas.push(d);
    }
    return { source: src, demoAvailable: this.demo !== null, today, serverTime: now, stats: queryDay(datas, day, tz, now) };
  }

  // ---------------------------------------------------------------- disk

  private file(key: string): string | null {
    return this.deps.dir ? join(this.deps.dir, `${key}.json`) : null;
  }

  private listFiles(): string[] {
    if (!this.deps.dir) return [];
    try {
      return readdirSync(this.deps.dir).filter((n) => FILE_RE.test(n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warnOnce('stats-dir', tr("Couldn't read {0} ({1}).", [this.deps.dir, errMsg(err)]));
      return [];
    }
  }

  /** Reads a day from disk; unreadable file is moved aside (`.corrupt`) and day restarts empty. */
  private readDay(key: string): DayData | null {
    const file = this.file(key);
    if (!file) return null;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warnOnce(`stats-read:${key}`, tr("Couldn't read {0} ({1}).", [file, errMsg(err)]));
      return null;
    }
    let data: DayData | null = null;
    try {
      data = parseDayFile(JSON.parse(raw), key);
    } catch {
      data = null;
    }
    if (data) return data;
    log.warnOnce(`stats-corrupt:${key}`, tr('{0} is unreadable; kept as .corrupt and the day starts over from zero.', [file]));
    try {
      renameSync(file, `${file}.corrupt`);
    } catch {
      // no permission: will be overwritten on next write
    }
    this.index.delete(key);
    return null;
  }

  private writeDay(d: DayData): boolean {
    const file = this.file(d.key);
    if (!file) return false;
    try {
      mkdirSync(this.deps.dir!, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(d.toFile()));
      renameSync(tmp, file);
      log.clearOnce('stats-write');
      return true;
    } catch (err) {
      log.warnOnce('stats-write', tr("Couldn't write {0} ({1}); stats are kept in memory only.", [file, errMsg(err)]));
      return false;
    }
  }

  /** Deletes files older than RETENTION_DAYS days. */
  private cleanup(today: string): void {
    this.retentionDay = today;
    const oldest = addDays(today, -RETENTION_DAYS);
    for (const key of [...this.index.keys()]) if (key < oldest) this.index.delete(key);
    for (const name of this.listFiles()) {
      const key = FILE_RE.exec(name)![1];
      if (key >= oldest) continue;
      try {
        unlinkSync(join(this.deps.dir!, name));
      } catch (err) {
        log.warnOnce(`stats-rm:${key}`, tr("Couldn't delete {0} ({1}).", [name, errMsg(err)]));
      }
    }
  }

  private safely(what: string, fn: () => void): void {
    try {
      fn();
      log.clearOnce(`stats-${what}-fail`);
    } catch (err) {
      log.warnOnce(`stats-${what}-fail`, tr('Day stats failed ({0}): {1}', [what, errMsg(err)]));
    }
  }
}

