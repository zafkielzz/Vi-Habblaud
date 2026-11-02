// The "Boss overloaded" list follows the thresholds from Settings.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeInfo, OfficeSnapshot } from '../../../shared/types';
import { loadedSessions, officeSessions, risenLoads, type LoadedSession } from './overload';

const session = (id: string, contextTokens: number, boss = false) =>
  ({ id, kind: 'main', model: 'claude-opus-4-6', boss, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens } }) as unknown as AgentInfo;

describe('loadedSessions', () => {
  it('uses the thresholds it is given, the defaults otherwise', () => {
    const agents = [session('a', 100_000), session('b', 130_000)];
    expect(loadedSessions(agents).map((s) => [s.agent.id, s.load.level])).toEqual([['b', 'tired']]);
    const t = { tired: 0.4, overloaded: 0.6, tiredCompacts: 1, overloadedCompacts: 2 };
    expect(loadedSessions(agents, t).map((s) => [s.agent.id, s.load.level])).toEqual([['b', 'overloaded'], ['a', 'tired']]);
  });

  it("an office sees only its own sessions (a session with no office is the first one's)", () => {
    const agents = [{ ...session('a', 190_000, true), office: 'o2' }, session('b', 190_000, true), { ...session('c', 130_000), office: 'o1' }];
    const offices = [{ id: 'o1' }, { id: 'o2' }] as OfficeInfo[];
    const snap = { agents, team: { workers: [], agy: [], offices } } as unknown as OfficeSnapshot;
    const ids = (o: OfficeInfo | undefined, s = snap) => officeSessions(loadedSessions(agents), s, o).map((x) => x.agent.id).sort();
    expect(ids(offices[1])).toEqual(['a']);
    expect(ids(offices[0])).toEqual(['b', 'c']);
    expect(ids(undefined)).toEqual(['a', 'b', 'c']);
    expect(ids(offices[0], { agents, team: { workers: [], agy: [], offices: [offices[0]] } } as unknown as OfficeSnapshot)).toEqual(['a', 'b', 'c']);
  });
});

describe('risenLoads', () => {
  const at = (id: string, level: 'tired' | 'overloaded') => ({ agent: { id }, load: { level, compacts: 0 } }) as unknown as LoadedSession;
  it('once per level, again only after the session was fine', () => {
    const told = new Map();
    const ids = (s: LoadedSession[]) => risenLoads(s, told).map((x) => `${x.agent.id}:${x.load.level}`);
    expect(ids([at('a', 'tired')])).toEqual(['a:tired']);
    expect(ids([at('a', 'tired')])).toEqual([]);
    expect(ids([at('a', 'overloaded'), at('b', 'tired')])).toEqual(['a:overloaded', 'b:tired']);
    // the context drops after a compaction: no second warning for a level already told
    expect(ids([at('a', 'tired'), at('b', 'tired')])).toEqual([]);
    expect(ids([at('b', 'tired')])).toEqual([]);
    expect(ids([at('a', 'tired'), at('b', 'tired')])).toEqual(['a:tired']);
  });
});
