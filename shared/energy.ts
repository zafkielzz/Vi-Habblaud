// A boss's or worker's energy (quiet, no tokens): how much of its account's quota is left, from the numbers the sidebar
// already shows. The coffee mug on its desk empties as the 5-hour window is used; when the window is exhausted the
// character sleeps at its desk until it renews. Plans without a 5-hour window (AccountUsage.noFiveHour) use the weekly
// one. No reading, or no window (AccountUsage.noQuota), means nothing to show: null.
import type { AccountUsage, UsageWindow } from './types';

export const FIVE_HOURS_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;

/** The window renewed since the reading: past its reset time or, without one, older than the window itself. */
export function windowRenewed(win: Pick<UsageWindow, 'resetsAt'>, fetchedAt: number, now: number, windowMs: number): boolean {
  return win.resetsAt !== undefined && Number.isFinite(win.resetsAt) ? win.resetsAt <= now : now - fetchedAt >= windowMs;
}

export interface Energy {
  /** Quota left, 0–100, rounded like the sidebar's %. */
  left: number;
  /** Full rows of coffee in the mug: 4 = full, 1 = the last quarter, 0 = empty (only when exhausted). */
  level: 0 | 1 | 2 | 3 | 4;
  /** The window is exhausted: the character sleeps at its desk when it has nothing to do. */
  asleep: boolean;
  /** When the window renews, if known. */
  resetsAt?: number;
}

const FULL: Energy = { left: 100, level: 4, asleep: false };

export function energyOf(usage: AccountUsage | undefined, now: number): Energy | null {
  if (!usage) return null;
  const win = usage.noFiveHour ? usage.sevenDay : usage.fiveHour;
  if (!win) return null;
  // Usage is unknown after a renewal, but the quota is back: this also wakes the character without a new reading.
  if (windowRenewed(win, usage.fetchedAt, now, usage.noFiveHour ? WEEK_MS : FIVE_HOURS_MS)) return FULL;
  const left = 100 - Math.round(Math.min(100, Math.max(0, win.utilization)));
  const energy: Energy = { left, level: Math.ceil(left / 25) as Energy['level'], asleep: left === 0 };
  if (win.resetsAt !== undefined && Number.isFinite(win.resetsAt)) energy.resetsAt = win.resetsAt;
  return energy;
}
