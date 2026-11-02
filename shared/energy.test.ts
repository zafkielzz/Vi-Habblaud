// Quota as energy: the mug's level and the quota sleep.
import { describe, expect, it } from 'vitest';
import { energyOf, FIVE_HOURS_MS, WEEK_MS, windowRenewed } from './energy';
import type { AccountUsage } from './types';

const NOW = 1_800_000_000_000;

function usage(five: number | undefined, week?: number, extra: Partial<AccountUsage> = {}): AccountUsage {
  return {
    source: 'agy',
    fetchedAt: NOW - 60_000,
    ...(five === undefined ? {} : { fiveHour: { utilization: five, resetsAt: NOW + 3_600_000 } }),
    ...(week === undefined ? {} : { sevenDay: { utilization: week, resetsAt: NOW + 86_400_000 } }),
    ...extra,
  };
}

describe('energyOf', () => {
  it('no reading or no window: nothing to show', () => {
    expect(energyOf(undefined, NOW)).toBeNull();
    expect(energyOf(usage(undefined, 10), NOW)).toBeNull();
    expect(energyOf(usage(undefined, undefined, { noQuota: true }), NOW)).toBeNull();
  });

  it('the mug empties a row per quarter of the quota used, and only runs dry when exhausted', () => {
    const level = (used: number) => energyOf(usage(used), NOW)!.level;
    expect(level(0)).toBe(4);
    expect(level(24)).toBe(4);
    expect(level(25)).toBe(3);
    expect(level(50)).toBe(2);
    expect(level(74)).toBe(2);
    expect(level(75)).toBe(1);
    expect(level(99)).toBe(1);
    expect(level(100)).toBe(0);
  });

  it('sleeps only when the window is exhausted, counting like the sidebar', () => {
    expect(energyOf(usage(98), NOW)).toMatchObject({ left: 2, asleep: false });
    expect(energyOf(usage(100), NOW)).toEqual({ left: 0, level: 0, asleep: true, resetsAt: NOW + 3_600_000 });
    // The sidebar rounds 99.6 to 100%: the character must not stay up beside a full bar.
    expect(energyOf(usage(99.6), NOW)!.asleep).toBe(true);
    expect(energyOf(usage(140), NOW)!.left).toBe(0);
    expect(energyOf(usage(-5), NOW)!.left).toBe(100);
  });

  it('the weekly window does not count while the plan has a 5-hour one', () => {
    expect(energyOf(usage(10, 100), NOW)).toMatchObject({ left: 90, asleep: false });
  });

  it('a plan without a 5-hour window falls back to the weekly figure', () => {
    expect(energyOf(usage(undefined, 60, { noFiveHour: true }), NOW)).toMatchObject({ left: 40, level: 2, asleep: false });
    expect(energyOf(usage(undefined, 100, { noFiveHour: true }), NOW)).toMatchObject({ left: 0, level: 0, asleep: true, resetsAt: NOW + 86_400_000 });
  });

  it('an exhausted window that renewed wakes the character without a new reading', () => {
    expect(energyOf(usage(100), NOW + 3_600_000)).toEqual({ left: 100, level: 4, asleep: false });
    const noReset = { source: 'agy', fetchedAt: NOW, fiveHour: { utilization: 100 } } as AccountUsage;
    expect(energyOf(noReset, NOW + FIVE_HOURS_MS - 1)!.asleep).toBe(true);
    expect(energyOf(noReset, NOW + FIVE_HOURS_MS)!.asleep).toBe(false);
    const weekly = { source: 'agy', fetchedAt: NOW, noFiveHour: true, sevenDay: { utilization: 100 } } as AccountUsage;
    expect(energyOf(weekly, NOW + FIVE_HOURS_MS)!.asleep).toBe(true);
  });
});

describe('windowRenewed', () => {
  it('uses the reset time when known, else the age of the reading', () => {
    expect(windowRenewed({ resetsAt: NOW }, 0, NOW, WEEK_MS)).toBe(true);
    expect(windowRenewed({ resetsAt: NOW + 1 }, 0, NOW, 1)).toBe(false);
    expect(windowRenewed({}, NOW - 10, NOW, 10)).toBe(true);
    expect(windowRenewed({ resetsAt: NaN }, NOW - 9, NOW, 10)).toBe(false);
  });
});
