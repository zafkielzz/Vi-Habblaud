// How loaded a Claude Code session is (the "Boss overloaded" warning), from what the transcript already gives, no
// tokens: the context in use (input + cache read + cache creation of the latest assistant message), the model's context
// window and how many times the session was compacted. Long sessions get slow and forgetful; this suggests writing
// a handoff and starting a fresh one.
import type { AgentInfo } from './types';

export type LoadLevel = 'ok' | 'tired' | 'overloaded';

export interface LoadThresholds {
  /** Share of the context window (0–1) from which the session is tired / overloaded. */
  tired: number;
  overloaded: number;
  /** Compactions from which the session is tired / overloaded. */
  tiredCompacts: number;
  overloadedCompacts: number;
}

export const DEFAULT_THRESHOLDS: LoadThresholds = { tired: 0.6, overloaded: 0.8, tiredCompacts: 1, overloadedCompacts: 2 };

/**
 * Context window guessed from the model id, used only when the session did not report its own (AgentInfo.contextWindow):
 * 1M for the "[1m]" variants and the Claude 5 generation (Opus/Sonnet/Haiku 5.x, Fable, Mythos), otherwise 200k.
 */
export function contextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  return /\[1m\]|-1m\b|claude-(?:(?:opus|sonnet|haiku)-5|fable|mythos)\b/i.test(model) ? 1_000_000 : 200_000;
}

export interface SessionLoad {
  level: LoadLevel;
  /** Context in use, 0–1 (of the model's window); undefined when the transcript has no usage yet. */
  share?: number;
  compacts: number;
}

export function sessionLoad(agent: Pick<AgentInfo, 'model' | 'stats' | 'contextWindow'>, t: LoadThresholds = DEFAULT_THRESHOLDS): SessionLoad {
  const compacts = agent.stats.compacts ?? 0;
  const ctx = agent.stats.contextTokens;
  const share = ctx === undefined ? undefined : Math.min(1, ctx / (agent.contextWindow || contextWindow(agent.model)));
  const s = share ?? 0;
  const level: LoadLevel =
    s >= t.overloaded || compacts >= t.overloadedCompacts ? 'overloaded' : s >= t.tired || compacts >= t.tiredCompacts ? 'tired' : 'ok';
  return share === undefined ? { level, compacts } : { level, share, compacts };
}
