// "My day": pure panel functions (no DOM), tested in ui/daystats-model.test.ts. They take DayStats from the
// API (shared/daystats.ts) and return what the screen renders: highlights, stacked bars by status with a
// common scale, hourly columns with a clean axis, account share, wait ranking, and labels.
import {
  TIMED_STATUSES,
  totalMs,
  type AccountDayStats,
  type DayStats,
  type HourDayStats,
  type RoomDayStats,
  type StatsSource,
  type StatusMs,
  type TimedStatus,
  type WaitDayStats,
} from '../../../shared/daystats';
import { formatInt, formatTokens, formatUSD } from './format';
import { intlLocale, tr } from '../../../shared/i18n';

/** Status labels in panel (same office vocabulary, from perspective of waiting user). */
export const STATUS_TEXT: Record<TimedStatus, string> = {
  waiting: tr('Waiting on you'),
  working: tr('Working'),
  idle: tr('Idle'),
  shell: tr('Waiting on shell'),
};

/**
 * Agent time: "12 s", "3 min", "2 h 10 min", and past one day, "27 h 5 min" (sum across multiple agents
 * exceeds 24 h without becoming "days").
 */
export function formatAgentTime(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < 60_000) return `${Math.floor(v / 1_000)} s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)} min`;
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Visible statuses (toggled by legend), always in stacking order. */
export type Visible = ReadonlySet<TimedStatus>;

export const ALL_VISIBLE: Visible = new Set(TIMED_STATUSES);

export function visibleTotal(ms: StatusMs, visible: Visible): number {
  return TIMED_STATUSES.reduce((n, s) => n + (visible.has(s) ? ms[s] : 0), 0);
}

export interface Segment {
  status: TimedStatus;
  ms: number;
  /** Width (or height) in % of scale. */
  pct: number;
}

/** Segments of a stacked bar (visible, non-empty statuses only), in % of `scale`. */
export function segments(ms: StatusMs, visible: Visible, scale: number): Segment[] {
  if (!(scale > 0)) return [];
  return TIMED_STATUSES.filter((s) => visible.has(s) && ms[s] > 0).map((s) => ({ status: s, ms: ms[s], pct: (ms[s] / scale) * 100 }));
}

/** Summary string per status (for screen readers and tables): "waiting on you 12 min, working 1 h 5 min". */
export function statusSummary(ms: StatusMs, visible: Visible = ALL_VISIBLE): string {
  const parts = TIMED_STATUSES.filter((s) => visible.has(s) && ms[s] > 0).map((s) => `${STATUS_TEXT[s].toLowerCase()} ${formatAgentTime(ms[s])}`);
  return parts.length ? parts.join(', ') : tr('no time recorded');
}

// ---------------------------------------------------------------- highlights

export interface Highlights {
  waiting: string;
  waitingMs: number;
  /** "12 min · Marina in store, at 14:32" (or empty if no waits). */
  longest: string;
  /** "Someone waited on you for 35 min" (wall clock time). */
  wall: string;
  waits: string;
  working: string;
  sessions: string;
  subagents: string;
  tokens: string;
  tokensDetail: string;
  /** "—" when transcripts included no cost. */
  cost: string;
  costHint: string;
  prompts: string;
  /** "84 tools · 6 tasks completed" */
  activity: string;
}

/**
 * `codex` = a Codex account worked today: cost reflects Claude Code only (Codex records tokens only,
 * not cost), indicated by tooltip.
 */
export function highlights(stats: DayStats, clock: (t: number) => string, codex = false): Highlights {
  const t = stats.totals;
  const c = t.counts;
  const top = stats.waits[0];
  const plural = (n: number, one: string, many: string) => `${formatInt(n)} ${n === 1 ? one : many}`;
  return {
    waiting: formatAgentTime(t.ms.waiting),
    waitingMs: t.ms.waiting,
    longest: top ? tr('{0} · {1} in {2}, at {3}{4}', [formatAgentTime(top.ms), top.agentName, top.roomName, clock(top.start), top.ongoing ? tr(' (still waiting)') : '']) : '',
    wall: t.waitWallMs > 0 ? tr('Someone waited on you for {0} of the day', [formatAgentTime(t.waitWallMs)]) : '',
    waits: t.waits ? plural(t.waits, tr('wait'), tr('waits')) : t.ms.waiting > 0 ? tr('only waits of a few seconds') : tr('no waits'),
    working: formatAgentTime(t.ms.working),
    sessions: formatInt(t.sessions),
    subagents: plural(t.subagents, tr('subagent'), tr('subagents')),
    tokens: formatTokens(c.tokensIn + c.tokensOut),
    tokensDetail: tr('{0} in · {1} out', [formatTokens(c.tokensIn), formatTokens(c.tokensOut)]),
    cost: c.costUSD > 0 ? formatUSD(c.costUSD) : '—',
    costHint:
      c.costUSD > 0
        ? codex
          ? tr("Claude Code only: Codex doesn't record cost, only tokens")
          : tr('Cost calculated by Claude Code itself')
        : c.tokensIn + c.tokensOut > 0
          ? codex
            ? tr("Codex doesn't record cost, only tokens")
            : tr("The transcripts didn't include the cost")
          : tr('No spending recorded'),
    prompts: formatInt(c.prompts),
    activity: `${plural(c.toolCalls, tr('tool'), tr('tools'))} · ${plural(c.tasksDone, tr('task completed'), tr('tasks completed'))}`,
  };
}

// ---------------------------------------------------------------- by project

export interface RoomRow {
  id: string;
  name: string;
  ms: StatusMs;
  total: number;
  segments: Segment[];
  /** "12 min waiting on you" */
  waiting: string;
  /** "3 h 10 min total" */
  totalText: string;
  label: string;
}

/** Bars by project: common scale (largest visible total), in API order (longest waits first). */
export function roomRows(rooms: readonly RoomDayStats[], visible: Visible): RoomRow[] {
  const scale = Math.max(0, ...rooms.map((r) => visibleTotal(r.ms, visible)));
  return rooms
    .filter((r) => totalMs(r.ms) > 0)
    .map((r) => {
      const total = visibleTotal(r.ms, visible);
      return {
        id: r.id,
        name: r.name,
        ms: r.ms,
        total,
        segments: segments(r.ms, visible, scale),
        waiting: tr('{0} waiting on you', [formatAgentTime(r.ms.waiting)]),
        totalText: tr('{0} total', [formatAgentTime(total)]),
        label: `${r.name}: ${statusSummary(r.ms, visible)}`,
      };
    });
}

// ---------------------------------------------------------------- by hour

export interface AxisScale {
  /** Axis top (ms). */
  max: number;
  /** Ticks (ms), bottom to top, excluding zero. */
  ticks: number[];
}

const NICE_MINUTES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 960, 1200, 1440];

/** Clean vertical axis for `value` (agent ms in an hour; exceeds 60 min with multiple agents). */
export function niceAxis(value: number): AxisScale {
  const minutes = Math.max(1, value / 60_000);
  const top = NICE_MINUTES.find((m) => m >= minutes) ?? Math.ceil(minutes / 1440) * 1440;
  // 2 to 4 ticks in clean equal steps: multiples of 1 h (or 30 min) above 2 h; 5 min below.
  const steps = top >= 120 ? [60, 30] : [5];
  let parts = 1;
  for (const unit of steps) {
    const p = [4, 3, 2].find((n) => Number.isInteger(top / n) && (top / n) % unit === 0);
    if (p) {
      parts = p;
      break;
    }
  }
  const step = top / parts;
  return { max: top * 60_000, ticks: Array.from({ length: parts }, (_, i) => (i + 1) * step * 60_000) };
}

/** Short label for an axis tick: "30 min", "1 h", "1 h 30", "2 h". */
export function axisLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export interface HourColumn {
  t: number;
  hour: number;
  ms: StatusMs;
  total: number;
  segments: Segment[];
  /** "14h–15h" */
  range: string;
  label: string;
  /** Current hour (today only). */
  now: boolean;
  /** Future hour (today, after current time). */
  future: boolean;
  /** X axis label on this column (every `every` hours). */
  tick: boolean;
}

export function hourColumns(hours: readonly HourDayStats[], visible: Visible, now: number, every = 3): { columns: HourColumn[]; axis: AxisScale } {
  const axis = niceAxis(Math.max(0, ...hours.map((h) => visibleTotal(h.ms, visible))));
  const columns = hours.map((h, i) => {
    const total = visibleTotal(h.ms, visible);
    const next = (h.hour + 1) % 24;
    const range = `${h.hour}h–${next}h`;
    return {
      t: h.t,
      hour: h.hour,
      ms: h.ms,
      total,
      segments: segments(h.ms, visible, axis.max),
      range,
      label: `${range}: ${statusSummary(h.ms, visible)}`,
      now: now >= h.t && now < (hours[i + 1]?.t ?? h.t + 3_600_000),
      future: h.t > now,
      tick: h.hour % every === 0,
    };
  });
  return { columns, axis };
}

// ---------------------------------------------------------------- by account

export interface AccountCard {
  id: string;
  name: string;
  short: string;
  color: string;
  /** Share of day's work time (0–100). */
  share: number;
  shareText: string;
  working: string;
  waiting: string;
  sessions: string;
  tokens: string;
  /** null = Codex account (does not record cost: card shows tokens only). */
  cost: string | null;
  /** Codex account (outlined chip). */
  codex: boolean;
}

/** `isCodex` identifies Codex accounts (daily protocol omits provider: inferred from snapshot or id). */
export function accountCards(accounts: readonly AccountDayStats[], isCodex: (id: string) => boolean = () => false): AccountCard[] {
  const work = accounts.reduce((n, a) => n + a.ms.working, 0);
  return accounts
    .filter((a) => totalMs(a.ms) > 0 || a.counts.tokensIn > 0)
    .map((a) => {
      const share = work > 0 ? Math.round((a.ms.working / work) * 100) : 0;
      const codex = isCodex(a.id);
      return {
        id: a.id,
        name: a.name,
        short: a.short,
        color: a.color,
        share,
        shareText: tr("{0}% of the day's work", [share]),
        working: formatAgentTime(a.ms.working),
        waiting: formatAgentTime(a.ms.waiting),
        sessions: `${formatInt(a.sessions)} ${a.sessions === 1 ? tr('session') : tr('sessions')}${a.subagents ? ` · ${formatInt(a.subagents)} sub` : ''}`,
        tokens: formatTokens(a.counts.tokensIn + a.counts.tokensOut),
        cost: codex ? null : a.counts.costUSD > 0 ? formatUSD(a.counts.costUSD) : '—',
        codex,
      };
    });
}

// ---------------------------------------------------------------- longest waits

export interface WaitRow {
  key: string;
  rank: number;
  duration: string;
  /** Bar width (% of longest wait). */
  pct: number;
  agentName: string;
  roomName: string;
  account: string;
  /** "14:32–14:44" */
  when: string;
  reason?: string;
  ongoing: boolean;
  label: string;
}

export function waitRows(waits: readonly WaitDayStats[], clock: (t: number) => string): WaitRow[] {
  const longest = Math.max(1, ...waits.map((w) => w.ms));
  return waits.map((w, i) => {
    const when = w.ongoing ? tr('since {0}', [clock(w.start)]) : `${clock(w.start)}–${clock(w.end)}`;
    const row: WaitRow = {
      key: `${w.agentId}|${w.start}`,
      rank: i + 1,
      duration: formatAgentTime(w.ms),
      pct: Math.max(2, (w.ms / longest) * 100),
      agentName: w.agentName,
      roomName: w.roomName,
      account: w.account,
      when,
      ongoing: !!w.ongoing,
      label: `${i + 1}º: ${formatAgentTime(w.ms)}, ${w.agentName} em ${w.roomName}, ${when}${w.reason ? tr(', for {0}', [w.reason]) : ''}${w.ongoing ? tr(', still waiting') : ''}`,
    };
    if (w.reason) row.reason = w.reason;
    return row;
  });
}

// ---------------------------------------------------------------- tables (accessible twin of each chart)

/** Status table rows: [name, each visible status..., total]. */
export function statusTable<T extends { ms: StatusMs }>(items: readonly T[], name: (item: T) => string, visible: Visible): { head: string[]; rows: string[][] } {
  const cols = TIMED_STATUSES.filter((s) => visible.has(s));
  return {
    head: [...cols.map((s) => STATUS_TEXT[s]), 'Total'],
    rows: items.map((it) => [name(it), ...cols.map((s) => (it.ms[s] > 0 ? formatAgentTime(it.ms[s]) : '—')), formatAgentTime(visibleTotal(it.ms, visible))]),
  };
}

// ---------------------------------------------------------------- days, URLs, and refresh

const weekdayFmt = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });

/** "Today", "Yesterday", or "Thu, 10/01" ("YYYY-MM-DD" date, independent of timezone). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return tr('Today');
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = today.split('-').map(Number);
  if (Date.UTC(ty, tm - 1, td) - t === 86_400_000) return tr('Yesterday');
  return weekdayFmt.format(t);
}

export function statsUrl(day: string, tz: string, source?: StatsSource): string {
  const q = new URLSearchParams({ day, tz });
  if (source) q.set('source', source);
  return `/api/stats?${q}`;
}

export function daysUrl(tz: string): string {
  return `/api/stats/days?${new URLSearchParams({ tz })}`;
}

/** Panel refreshes automatically only when open and viewing today. */
export function shouldRefresh(open: boolean, day: string, today: string): boolean {
  return open && day === today;
}

/** Does the day have nothing to display? */
export function isEmptyDay(stats: DayStats): boolean {
  return totalMs(stats.totals.ms) === 0 && stats.totals.counts.tokensIn === 0 && stats.waits.length === 0;
}
