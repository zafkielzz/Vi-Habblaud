// Level, XP and badges of the Antigravity workers (only from agy-ask "end" lines).
import { describe, expect, it } from 'vitest';
import { levelOf, levelStart, rankOf, WorkerTracker } from './progress';
import type { AgyAskLine } from './source';

/** "end" line at `hour` o'clock (local) on 2026-10-26. */
function end(status: string, sec: number, tokens = 0, hour = 14): AgyAskLine {
  const at = new Date(2026, 9, 26, hour, 0, 0).getTime() / 1000;
  return { event: 'end', status, sec, ts: at + sec, usage: { total_tokens: tokens } };
}

describe('levels', () => {
  it('level n starts at 25·n·(n−1) XP', () => {
    expect([1, 2, 3, 4, 5].map(levelStart)).toEqual([0, 50, 150, 300, 500]);
    expect([0, 49, 50, 149, 150, 499, 500].map(levelOf)).toEqual([1, 1, 2, 2, 3, 4, 5]);
    expect([1, 3, 5, 8, 12].map(rankOf)).toEqual(['Intern', 'Junior', 'Mid-level', 'Senior', 'Legend']);
  });
});

describe('WorkerTracker', () => {
  it('XP: 10 per job + 1 per 5k tokens (up to +40); a failure is worth 2', () => {
    const t = new WorkerTracker();
    t.feed(end('SUCCESS', 30, 12_000));
    t.feed(end('SUCCESS', 30, 1_000_000));
    t.feed(end('TIMEOUT', 900));
    expect(t.view()).toMatchObject({ xp: 12 + 50 + 2, level: 2, jobs: 2 });
  });

  it('badges: first, lightning, owl, marathon, survivor, millionaire', () => {
    const t = new WorkerTracker();
    expect(t.feed(end('SUCCESS', 8, 10, 2)).badges).toEqual(['first', 'flash', 'owl']);
    expect(t.feed(end('SUCCESS', 700)).badges).toEqual(['marathon']);
    expect(t.feed(end('TIMEOUT', 900)).badges).toEqual([]);
    expect(t.feed(end('SUCCESS', 40, 1_000_000)).badges).toEqual(['survivor', 'million']);
    expect(t.feed(end('SUCCESS', 9)).badges).toEqual([]);
    expect(t.view().badges.map((b) => b.icon)).toEqual(['🐣', '⚡', '🦉', '🏃', '👻', '💰']);
  });

  it('unbeatable: 25 in a row without failure (a failure resets); a level-up comes in the event', () => {
    const t = new WorkerTracker();
    const events = Array.from({ length: 24 }, () => t.feed(end('SUCCESS', 30)));
    expect(events.find((e) => e.levelUp)?.levelUp).toBe(2);
    t.feed(end('KILLED', 3));
    for (let i = 0; i < 24; i++) t.feed(end('SUCCESS', 30));
    expect(t.view().badges.some((b) => b.id === 'streak')).toBe(false);
    expect(t.feed(end('SUCCESS', 30)).badges).toEqual(['streak']);
  });

  it('"start" lines do not count', () => {
    const t = new WorkerTracker();
    expect(t.feed({ event: 'start', ts: 1 })).toEqual({ badges: [] });
    expect(t.view().xp).toBe(0);
  });
});
