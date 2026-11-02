// The "Boss overloaded" list follows the thresholds from Settings.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { loadedSessions } from './overload';

const session = (id: string, contextTokens: number, boss = false) =>
  ({ id, kind: 'main', model: 'claude-opus-4-6', boss, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens } }) as unknown as AgentInfo;

describe('loadedSessions', () => {
  it('uses the thresholds it is given, the defaults otherwise', () => {
    const agents = [session('a', 100_000), session('b', 130_000)];
    expect(loadedSessions(agents).map((s) => [s.agent.id, s.load.level])).toEqual([['b', 'tired']]);
    const t = { tired: 0.4, overloaded: 0.6, tiredCompacts: 1, overloadedCompacts: 2 };
    expect(loadedSessions(agents, t).map((s) => [s.agent.id, s.load.level])).toEqual([['b', 'overloaded'], ['a', 'tired']]);
  });
});
