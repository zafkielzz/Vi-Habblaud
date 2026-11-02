import { describe, expect, it } from 'vitest';
import { SPECIAL } from '../../shared/activity';
import type { Activity, AgentInfo, TaskItem } from '../../shared/types';
import { AgentSignals, isCompaction } from './signals';

const T0 = Date.UTC(2026, 9, 15, 10);
const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

function agent(id: string, tasks: TaskItem[] = [], recent: Activity[] = []): AgentInfo {
  return {
    id, kind: 'main', roomId: '/p', name: 'Ana', look: 'f', role: 'x', sessionId: 's', account: '.claude', status: 'working',
    recent, tasks, startedAt: T0, lastEventAt: T0, statusSince: T0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1,
  };
}
const tasks = (done: number, pending = 1): TaskItem[] => [
  ...Array.from({ length: done }, (_, i) => ({ id: `d${i}`, title: 't', status: 'completed' as const })),
  ...Array.from({ length: pending }, (_, i) => ({ id: `p${i}`, title: 't', status: 'pending' as const })),
];
const act = (id: string, d: ReturnType<typeof SPECIAL.compact>): Activity => ({ id, at: T0, ...d });

describe('AgentSignals', () => {
  it('tasks today: only increases count, replaced list does not decrease, day rollover resets', () => {
    const s = new AgentSignals(dayKey);
    expect(s.observe([agent('m1', tasks(2))], T0).tasksToday.get('m1')).toBe(2);
    expect(s.observe([agent('m1', tasks(4))], T0 + 1000).tasksToday.get('m1')).toBe(4);
    // New TodoWrite: fresh list, then 1 completed.
    expect(s.observe([agent('m1', tasks(0, 3))], T0 + 2000).tasksToday.get('m1')).toBe(4);
    expect(s.observe([agent('m1', tasks(1, 2))], T0 + 3000).tasksToday.get('m1')).toBe(5);
    expect(s.observe([agent('m1', tasks(1, 2))], T0 + DAY).tasksToday.get('m1')).toBe(0);
    expect(s.observe([agent('m1', tasks(3, 0))], T0 + DAY + 1000).tasksToday.get('m1')).toBe(2);
  });

  it('new compaction becomes pending until dispatch is sent; /clear and old ones do not count', () => {
    const s = new AgentSignals(dayKey);
    const old = act('c-velha', SPECIAL.compact());
    expect(s.observe([agent('m1', [], [old])], T0).compacted.size).toBe(0);
    const clear = act('x#clear:1', SPECIAL.cleared());
    expect(isCompaction(clear)).toBe(false);
    expect(s.observe([agent('m1', [], [old, clear])], T0 + 1).compacted.size).toBe(0);
    const fresh = act('c-nova', SPECIAL.compact());
    expect([...s.observe([agent('m1', [], [old, clear, fresh])], T0 + 2).compacted]).toEqual(['m1']);
    // Without dispatch, remains pending.
    expect([...s.observe([agent('m1', [], [old, clear, fresh])], T0 + 3).compacted]).toEqual(['m1']);
    s.sent();
    expect(s.observe([agent('m1', [], [old, clear, fresh])], T0 + 4).compacted.size).toBe(0);
  });

  it('agents that disappear are forgotten', () => {
    const s = new AgentSignals(dayKey);
    s.observe([agent('m1', tasks(3)), agent('m2')], T0);
    expect([...s.observe([agent('m2')], T0 + 1).tasksToday.keys()]).toEqual(['m2']);
  });
});
