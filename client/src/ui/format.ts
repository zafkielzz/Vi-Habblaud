// Formatting in the active language (times, numbers, usage). Pure functions: no DOM, tested in ui/format.test.ts.
import { FIVE_HOURS_MS, WEEK_MS, windowRenewed } from '../../../shared/energy';
import { intlLocale, tr } from '../../../shared/i18n';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LOCALE = intlLocale();

const numberFmt1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const integerFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const usdFmt = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 24-hour clock in all languages (in English AM/PM does not fit in the feed column).
const clockFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSecFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Relative time in the past: "now", "5 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function relativeTime(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < 5 * SECOND) return tr('now');
  if (diff < MINUTE) return tr('{0} s ago', [Math.floor(diff / SECOND)]);
  if (diff < HOUR) return tr('{0} min ago', [Math.floor(diff / MINUTE)]);
  if (diff < DAY) return tr('{0} h ago', [Math.floor(diff / HOUR)]);
  return tr('{0} d ago', [Math.floor(diff / DAY)]);
}

/** Readable duration: "12 s", "3 min", "2 h 10 min", "3 d 4 h". */
export function formatDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)} s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)} min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d} d ${h} h` : `${d} d`;
}

/**
 * Stopwatch for ongoing activity: "0:07", "12:31", "1:02:10"; from 1 day up, "1 d 2 h".
 * Ticks every second (good for running time); negative values (out-of-sync clocks) become "0:00".
 */
export function formatElapsed(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v >= DAY) return formatDuration(v);
  const total = Math.floor(v / SECOND);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Countdown: "2 h 10 min left", "5 min left", "in less than 1 min", "now". */
export function formatCountdown(target: number, now: number): string {
  const diff = target - now;
  if (diff <= 0) return tr('now');
  if (diff < MINUTE) return tr('in less than 1 min');
  return tr('{0} left', [formatDuration(diff)]);
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** How many calendar days (local time) separate `t` from `now` (0 = same day). */
export function calendarDayDiff(t: number, now: number): number {
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY);
}

/**
 * When a usage window resets: "at 14:30" (today), "tomorrow at 01:30", or "Thu, 20:00".
 * Past timestamp returns "" (never shows a past reset as if it were the next).
 */
export function formatResetAt(resetsAt: number, now: number): string {
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return '';
  const time = clockFmt.format(resetsAt);
  const days = calendarDayDiff(resetsAt, now);
  if (days <= 0) return tr('at {0}', [time]);
  if (days === 1) return tr('tomorrow at {0}', [time]);
  return `${weekdayFmt.format(resetsAt)}, ${time}`;
}

/** Compact duration for minimal spaces: "45s", "29min", "1h29", "2h", "3d4h". */
export function compactDuration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < MINUTE) return `${Math.floor(v / SECOND)}s`;
  if (v < HOUR) return `${Math.floor(v / MINUTE)}min`;
  if (v < DAY) {
    const h = Math.floor(v / HOUR);
    const m = Math.floor((v % HOUR) / MINUTE);
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  return h ? `${d}d${h}h` : `${d}d`;
}

export { FIVE_HOURS_MS, WEEK_MS };

/** Display of a usage window (5 h or week), factoring in data age. */
export interface UsageWindowView {
  /** Percentage 0–100; null when the window renewed after reading (current usage unknown). */
  pct: number | null;
  /** The window has already reset since the numbers were fetched. */
  renewed: boolean;
  /** Next reset: "1 h 29 min left" (under 24 h), "tomorrow, 13:49", or "Thu, 13:49"; "" if unknown. */
  reset: string;
  /** Compact countdown to reset ("1h29"), for small screens; "" if unknown. */
  resetShort: string;
  /** Full sentence for tooltips and screen readers. */
  summary: string;
}

/**
 * `windowMs` is the window duration (5 h or 7 d): without a reset time, numbers read older than this
 * are stale (the window has certainly renewed).
 */
export function usageWindowView(win: { utilization: number; resetsAt?: number } | undefined, fetchedAt: number, now: number, windowMs: number): UsageWindowView | null {
  if (!win) return null;
  const resetsAt = win.resetsAt !== undefined && Number.isFinite(win.resetsAt) ? win.resetsAt : undefined;
  if (windowRenewed(win, fetchedAt, now, windowMs)) {
    return {
      pct: null,
      renewed: true,
      reset: tr('renewed'),
      resetShort: tr('renewed'),
      summary: tr('renewed since the last reading (current usage unknown)'),
    };
  }
  const pct = clampPercent(win.utilization);
  if (resetsAt === undefined) return { pct, renewed: false, reset: '', resetShort: '', summary: tr('{0}% used', [pct]) };
  const diff = resetsAt - now;
  let reset: string;
  if (diff < DAY) reset = formatCountdown(resetsAt, now);
  else {
    const time = clockFmt.format(resetsAt);
    reset = calendarDayDiff(resetsAt, now) === 1 ? tr('tomorrow, {0}', [time]) : `${weekdayFmt.format(resetsAt)}, ${time}`;
  }
  const at = formatResetAt(resetsAt, now);
  return {
    pct,
    renewed: false,
    reset,
    resetShort: compactDuration(diff),
    summary: tr('{0}% used · resets {1} ({2})', [pct, at, formatCountdown(resetsAt, now)]),
  };
}

/** "14:30:05" */
export function formatClock(at: number, withSeconds = true): string {
  return (withSeconds ? clockSecFmt : clockFmt).format(at);
}

/** "Oct 06, 14:30" */
export function formatDateTime(at: number): string {
  return dateTimeFmt.format(at);
}

/** Compact tokens: "850", "12.3 k", "1.2 M". */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  if (v < 1_000) return integerFmt.format(v);
  if (v < 1_000_000) return `${numberFmt1.format(v / 1_000)} k`;
  return `${numberFmt1.format(v / 1_000_000)} M`;
}

/** Integer with thousands separator: "12,345". */
export function formatInt(n: number): string {
  return integerFmt.format(n);
}

/** Cost in USD: "$1.23". */
export function formatUSD(n: number): string {
  return usdFmt.format(n).replace(/ /g, ' ');
}

/** Usage percentage clamped to 0–100 and rounded. */
export function clampPercent(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)));
}

export type UsageLevel = 'ok' | 'warn' | 'crit';

/** Usage color tier: green < 50%, amber 50–80%, red >= 80%. */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 80) return 'crit';
  if (utilization >= 50) return 'warn';
  return 'ok';
}

/** "1 agent", "3 agents" */
export function plural(n: number, singular: string, pluralForm: string): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Strips diacritics and normalizes for search ("João" -> "joao"). */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export { prettyModel } from '../../../shared/model-spec';

const PERMISSION_LABELS: Record<string, string> = {
  default: tr('Default (asks)'),
  acceptEdits: tr('Accepts edits'),
  // Antigravity (agy-ask --mode)
  'accept-edits': tr('Accepts edits'),
  plan: tr('Plan mode'),
  bypassPermissions: tr('No confirmations'),
  dontAsk: tr("Doesn't ask"),
  auto: tr('Automatic'),
};

export function permissionLabel(mode: string | undefined): string {
  if (!mode) return '—';
  return PERMISSION_LABELS[mode] ?? mode;
}

/** Shortens home directory paths: "/Users/ana/projects/x" -> "~/projects/x". */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
