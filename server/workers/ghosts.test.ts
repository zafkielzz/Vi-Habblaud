// Hung workers: the decision, and one Board line per ghost.
import { describe, expect, it } from 'vitest';
import type { AgentGhost, NewsItem } from '../../shared/types';
import { GHOST_SILENCE_MS, ghostOf, GhostWatch, type GhostCandidate } from './ghosts';

const T0 = 1_800_000_000_000;

describe('ghostOf', () => {
  const c = { agentId: 'agy:acc2', name: 'two', pid: 42 };

  it('a job silent for the whole threshold is a ghost, a moment less is not', () => {
    expect(ghostOf({ ...c, lastSign: T0 - GHOST_SILENCE_MS + 1 }, T0)).toBeUndefined();
    expect(ghostOf({ ...c, lastSign: T0 - GHOST_SILENCE_MS }, T0)).toEqual({ reason: 'stalled', since: T0 - GHOST_SILENCE_MS, pid: 42 });
  });

  it('a process with no job left waits the same silence, and says so', () => {
    expect(ghostOf({ ...c, lastSign: T0 - 1_000, jobless: true }, T0)).toBeUndefined();
    expect(ghostOf({ ...c, lastSign: T0 - GHOST_SILENCE_MS, jobless: true }, T0)?.reason).toBe('no-job');
  });
});

function setup() {
  let clock = T0;
  let list: GhostCandidate[] = [];
  const flags = new Map<string, AgentGhost | undefined>();
  const news: NewsItem[] = [];
  const watch = new GhostWatch({ office: { setGhost: (id, g) => void flags.set(id, g) }, candidates: () => list, news: (n) => void news.push(n), now: () => clock });
  return { watch, flags, news, tick: (ms: number, l = list) => ((clock += ms), (list = l), watch.check()) };
}

describe('GhostWatch', () => {
  const job: GhostCandidate = { agentId: 'agy:acc2', name: 'two', pid: 42, lastSign: T0 };

  it('flags the character and tells the Board once, however long it stays a ghost', () => {
    const t = setup();
    t.tick(GHOST_SILENCE_MS - 1, [job]);
    expect(t.flags.size).toBe(0);
    t.tick(1);
    t.tick(60_000);
    t.tick(60_000);
    expect(t.flags.get('agy:acc2')).toEqual({ reason: 'stalled', since: T0, pid: 42 });
    expect(t.news).toHaveLength(1);
    expect(t.news[0]).toMatchObject({ id: 'ghost:agy:acc2:42', kind: 'ghost', icon: '👻', text: 'two looks hung' });
    expect(t.news[0].detail).toContain('PID 42');
  });

  it('a sign of life or the process going away clears the flag', () => {
    const t = setup();
    t.tick(GHOST_SILENCE_MS, [job]);
    t.tick(1_000, [{ ...job, lastSign: T0 + GHOST_SILENCE_MS }]);
    expect(t.flags.get('agy:acc2')).toBeUndefined();
    t.tick(GHOST_SILENCE_MS);
    expect(t.flags.get('agy:acc2')).toBeDefined();
    t.tick(1_000, []);
    expect(t.flags.get('agy:acc2')).toBeUndefined();
    expect(t.flags.has('agy:acc2')).toBe(true);
  });

  it('tells apart a hung job and a process with no job', () => {
    const t = setup();
    t.tick(GHOST_SILENCE_MS, [{ ...job, jobless: true }]);
    expect(t.news[0].text).toBe('two: agy is still alive with no job');
    expect(t.flags.get('agy:acc2')?.reason).toBe('no-job');
  });
});
