import type { AccountInfo } from '../../../shared/types';
import { describe, expect, it } from 'vitest';
import { peakUsage, quotaWindows, usageLine, validClaudeName } from './accounts';

const NOW = 1_800_000_000_000;

describe('accounts dialog', () => {
  it('usage line: both windows, week only without the 5-hour one, nothing without a reading', () => {
    const usage = { source: 'cache' as const, fetchedAt: NOW - 60_000, fiveHour: { utilization: 42.4, resetsAt: NOW + 3_600_000 }, sevenDay: { utilization: 10, resetsAt: NOW + 86_400_000 } };
    expect(usageLine({ usage }, NOW)).toBe('5 h 42% · week 10%');
    expect(usageLine({ usage: { ...usage, noFiveHour: true } }, NOW)).toBe('week 10%');
    expect(usageLine({ usage: undefined }, NOW)).toBe('');
    expect(usageLine(undefined, NOW)).toBe('');
  });

  it('Claude account names become ~/.claude-<name>: no paths or dots', () => {
    expect(validClaudeName('work')).toBe(true);
    expect(validClaudeName('acc_2-b')).toBe(true);
    expect(validClaudeName('')).toBe(false);
    expect(validClaudeName('../x')).toBe(false);
    expect(validClaudeName('-x')).toBe(false);
  });
});

describe('quota of an account', () => {
  const NOW = 1_800_000_000_000;
  const usage = (five: number, week: number, extra = {}) => ({ source: 'agy', fetchedAt: NOW - 60_000, fiveHour: { utilization: five, resetsAt: NOW + 3_600_000 }, sevenDay: { utilization: week, resetsAt: NOW + 86_400_000 * 3 }, ...extra });

  it('both windows with their %, the fuller one as the peak', () => {
    const a = { usage: usage(42, 81) } as unknown as AccountInfo;
    expect(quotaWindows(a, NOW).map((w) => [w.label, w.pct])).toEqual([['5 h', 42], ['week', 81]]);
    expect(peakUsage(a, NOW)).toBe(81);
  });

  it('no numbers yet ("disabled") is not a full quota: no bars, no warning', () => {
    const a = { usageStatus: 'disabled' } as unknown as AccountInfo;
    expect(quotaWindows(a, NOW)).toEqual([]);
    expect(peakUsage(a, NOW)).toBeNull();
  });

  it('a plan without the 5-hour window shows the week only', () => {
    const a = { usage: usage(0, 20, { noFiveHour: true }) } as unknown as AccountInfo;
    expect(quotaWindows(a, NOW).map((w) => w.label)).toEqual(['week']);
  });
});
