// How loaded a Claude Code session is (the "Boss overloaded" warning).
import { describe, expect, it } from 'vitest';
import { contextWindow, DEFAULT_THRESHOLDS, sanitizeThresholds, sessionLoad } from './overload';
import type { AgentStats } from './types';

function load(contextTokens: number | undefined, compacts = 0, model = 'claude-opus-4-6', window?: number) {
  const stats = { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens, compacts } as AgentStats;
  return sessionLoad({ model, stats, contextWindow: window });
}

describe('sessionLoad', () => {
  it('guessed context window: 1M for [1m] models and the Claude 5 generation, 200k otherwise', () => {
    expect(contextWindow('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(contextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(contextWindow('claude-sonnet-5-5')).toBe(1_000_000);
    expect(contextWindow('claude-haiku-5-5')).toBe(1_000_000);
    expect(contextWindow('claude-fable-5-1')).toBe(1_000_000);
    expect(contextWindow('claude-opus-4-6')).toBe(200_000);
    expect(contextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(contextWindow(undefined)).toBe(200_000);
  });

  it('the window the session reported wins over the guess from the model', () => {
    // 422k on Opus 5.5 (1M) was reported as overloaded with the old 200k guess (27/10).
    expect(load(422_000, 0, 'claude-opus-5-5').level).toBe('ok');
    expect(load(422_000, 0, 'claude-opus-5-5', 1_000_000).level).toBe('ok');
    expect(load(170_000, 0, 'claude-opus-5-5', 200_000).level).toBe('overloaded');
    expect(load(170_000, 0, 'claude-opus-4-6', 1_000_000).level).toBe('ok');
  });

  it('tired from 60% of the window or 1 compaction, overloaded from 80% or 2', () => {
    expect(load(100_000)).toEqual({ level: 'ok', share: 0.5, compacts: 0 });
    expect(load(120_000).level).toBe('tired');
    expect(load(160_000).level).toBe('overloaded');
    expect(load(160_000, 0, 'claude-opus-4-6[1m]').level).toBe('ok');
    expect(load(10_000, 1).level).toBe('tired');
    expect(load(10_000, 2).level).toBe('overloaded');
  });

  it('no usage yet: only the compactions count', () => {
    expect(load(undefined)).toEqual({ level: 'ok', compacts: 0 });
    expect(load(undefined, 2)).toEqual({ level: 'overloaded', compacts: 2 });
  });
});

describe('thresholds from Settings', () => {
  const stats = (contextTokens: number, compacts = 0) => ({ model: 'claude-opus-4-6', stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens, compacts } as AgentStats });

  it('sessionLoad uses the ones it is given, the fixed defaults otherwise', () => {
    const t = { tired: 0.3, overloaded: 0.5, tiredCompacts: 3, overloadedCompacts: 5 };
    expect(sessionLoad(stats(50_000)).level).toBe('ok');
    expect(sessionLoad(stats(70_000), t).level).toBe('tired');
    expect(sessionLoad(stats(100_000), t).level).toBe('overloaded');
    expect(sessionLoad(stats(10_000, 2), t).level).toBe('ok');
    expect(sessionLoad(stats(10_000, 3), t).level).toBe('tired');
    expect(sessionLoad(stats(10_000, 5), t).level).toBe('overloaded');
  });

  it('no saved value = the defaults', () => {
    expect(sanitizeThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    expect(sanitizeThresholds('nonsense')).toEqual(DEFAULT_THRESHOLDS);
    expect(sanitizeThresholds({ tired: 'x', overloaded: NaN, tiredCompacts: null })).toEqual(DEFAULT_THRESHOLDS);
  });

  it('keeps good values and brings the others into range', () => {
    expect(sanitizeThresholds({ tired: 0.5, overloaded: 0.7, tiredCompacts: 2, overloadedCompacts: 4 })).toEqual({ tired: 0.5, overloaded: 0.7, tiredCompacts: 2, overloadedCompacts: 4 });
    expect(sanitizeThresholds({ tired: 0.01, overloaded: 7, tiredCompacts: -1, overloadedCompacts: 500 })).toEqual({ tired: 0.1, overloaded: 1, tiredCompacts: 1, overloadedCompacts: 99 });
    expect(sanitizeThresholds({ tired: 0.333, tiredCompacts: 1.6 })).toMatchObject({ tired: 0.33, tiredCompacts: 2 });
  });

  it('tired never starts after overloaded', () => {
    expect(sanitizeThresholds({ tired: 0.9, overloaded: 0.7, tiredCompacts: 5, overloadedCompacts: 3 })).toEqual({ tired: 0.7, overloaded: 0.7, tiredCompacts: 3, overloadedCompacts: 3 });
  });
});
