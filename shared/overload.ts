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

/** Limits of the two kinds of threshold (Settings). */
export const SHARE_RANGE = { min: 0.1, max: 1 } as const;
export const COMPACTS_RANGE = { min: 1, max: 99 } as const;

/**
 * Thresholds from Settings, field by field: what is missing or not a number falls back to its default, the rest is
 * brought into range, and tired never starts after overloaded (it would never show).
 */
export function sanitizeThresholds(raw: unknown): LoadThresholds {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_THRESHOLDS;
  const share = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(SHARE_RANGE.max, Math.max(SHARE_RANGE.min, v)) * 100) / 100 : fallback;
  const compacts = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(COMPACTS_RANGE.max, Math.max(COMPACTS_RANGE.min, v))) : fallback;
  const overloaded = share(o.overloaded, d.overloaded);
  const overloadedCompacts = compacts(o.overloadedCompacts, d.overloadedCompacts);
  return { tired: Math.min(share(o.tired, d.tired), overloaded), overloaded, tiredCompacts: Math.min(compacts(o.tiredCompacts, d.tiredCompacts), overloadedCompacts), overloadedCompacts };
}

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
