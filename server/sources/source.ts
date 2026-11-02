// Agent sources (one per tool: Claude Code, Codex...) and what the rest of the server expects from them.
//
// Each source watches OPEN sessions of its tool and feeds the Office (addMain, addActivity...). The
// server binds them all via a SourceSet: snapshot (meta.sources), /api/health, terminal, and agent
// transcript path go through it, agnostic of which tool the agent comes from. Currently there is Claude
// Code (sources/watcher.ts, ClaudeWatcher); Codex connects through the same contract.
//
// Terminal history (recent sessions, open or closed): one HistoryProvider per tool, united in a
// HistorySet serving /api/sessions/* routes. Claude Code's is SessionHistory (sources/history.ts).
//
// Boot: a source reconstructing open sessions at startup calls office.beginBoot() before and office.endBoot()
// after, ALWAYS in pairs (in a `finally`, including async boot). Office tracks boot counts: while any
// source boots there are no alerts and feed is buffered to flush in chronological order at end of last boot (a
// source never calling endBoot would silence alerts for all).
import type { Provider, RecentSession, SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { HISTORY_LIMIT } from './history';
import { createTerminalParser, type TerminalParser } from './terminal';
import { tr } from '../../shared/i18n';

/** An agent source: watches open sessions of a tool and feeds the Office. */
export interface AgentSource {
  readonly provider: Provider;
  /**
   * Boot (reconstructs open sessions, between office.beginBoot/endBoot) and live tracking. A synchronous
   * source finishes boot before returning; an async one returns a promise (failures only go to log).
   */
  start(): void | Promise<void>;
  stop(): void;
  /** One entry per observed account (snapshot meta.sources and /api/health). */
  sources(): SourceInfo[];
  /** Conversation file for a present agent of this source; undefined if agent is not from it (or no file yet). */
  transcriptPathOf(agentId: string): string | undefined;
  /**
   * Terminal parser for an agent's conversation from this source: NEW on each call (parsers are stateful).
   * Missing, or undefined, = Claude Code's parser (createTerminalParser).
   */
  terminalParser?(agentId: string): TerminalParser | undefined;
}

/** All connected agent sources, viewed as one. */
export class SourceSet {
  private readonly list: AgentSource[] = [];

  constructor(sources: readonly AgentSource[] = []) {
    for (const s of sources) this.add(s);
  }

  /** Adds a source (before start()). */
  add(source: AgentSource): void {
    this.list.push(source);
  }

  all(): readonly AgentSource[] {
    return this.list;
  }

  /** A tool's source, if connected. */
  of(provider: Provider): AgentSource | undefined {
    return this.list.find((s) => s.provider === provider);
  }

  /**
   * Starts sources in order added: synchronous ones finish boot right here (before hub starts
   * broadcasting). Failure of one does not block others: goes to log. Promise resolves when
   * async sources finish connecting.
   */
  start(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const s of this.list) {
      const failed = (err: unknown) => log.error(tr('Agent source {0}: failed to start ({1}).', [s.provider, errMsg(err)]));
      try {
        const r = s.start();
        if (r) pending.push(r.catch(failed));
      } catch (err) {
        failed(err);
      }
    }
    return Promise.all(pending).then(() => undefined);
  }

  stop(): void {
    for (const s of this.list) {
      try {
        s.stop();
      } catch (err) {
        log.warn(tr('Agent source {0}: failed to stop ({1}).', [s.provider, errMsg(err)]));
      }
    }
  }

  sources(): SourceInfo[] {
    return this.list.flatMap((s) => s.sources());
  }

  /** Conversation file of a present agent (first source that knows it). */
  transcriptPathOf(agentId: string): string | undefined {
    for (const s of this.list) {
      const path = s.transcriptPathOf(agentId);
      if (path) return path;
    }
    return undefined;
  }

  /**
   * NEW parser for an agent's terminal: from source that knows its transcript (transcriptPathOf);
   * without source, or if source lacks its own, Claude Code's.
   */
  parserFor(agentId: string): TerminalParser {
    const owner = this.list.find((s) => s.transcriptPathOf(agentId) !== undefined);
    return owner?.terminalParser?.(agentId) ?? createTerminalParser();
  }
}

// ------------------------------------------------------------------ terminal history

/** Located history session: conversation file and terminal parser for it. */
export interface HistorySession {
  path: string;
  /** NEW parser on each call (terminal creates another when file is truncated or replaced). */
  createParser: () => TerminalParser;
}

/** Result of resolve(): session or HTTP error. */
export type HistoryResolveResult = HistorySession | { status: 400 | 404; error: string };

/** What /api/sessions/* routes need: a single provider or HistorySet. */
export interface SessionLookup {
  /** Recent sessions, from newest activity to oldest. */
  list(): Promise<RecentSession[]>;
  /**
   * Validates and finds session `sessionId` of account (no path traversal). Never throws: 400 = invalid ID,
   * 404 = unknown account or session.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult;
}

/** History of a tool: recent sessions of its accounts. */
export interface HistoryProvider extends SessionLookup {
  readonly provider: Provider;
  /** Account belongs to this provider (HistorySet routes resolve() here). */
  hasAccount(account: string): boolean;
}

/**
 * Unites history across all tools: lists all (from newest activity to oldest, up to `limit`) and resolves
 * each session via account provider. Account unknown to all providers falls back to first (Claude Code),
 * giving standard error (400 for invalid ID, else 404).
 */
export class HistorySet implements SessionLookup {
  private readonly list_: HistoryProvider[] = [];

  constructor(
    providers: readonly HistoryProvider[] = [],
    private readonly limit = HISTORY_LIMIT,
  ) {
    for (const p of providers) this.add(p);
  }

  add(provider: HistoryProvider): void {
    this.list_.push(provider);
  }

  /** A failing provider does not bring down listing of others (goes to log); if all fail, error bubbles up. */
  async list(): Promise<RecentSession[]> {
    const results = await Promise.allSettled(this.list_.map((p) => p.list()));
    const out: RecentSession[] = [];
    const failures: Array<{ provider: Provider; err: unknown }> = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(...r.value);
      else failures.push({ provider: this.list_[i].provider, err: r.reason });
    });
    if (failures.length && failures.length === results.length) throw failures[0].err;
    for (const f of failures) {
      log.warnOnce(`history-list:${f.provider}:${errMsg(f.err)}`, tr('Session history ({0}): failed to list ({1}).', [f.provider, errMsg(f.err)]));
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const owner = this.list_.find((p) => p.hasAccount(account)) ?? this.list_[0];
    return owner ? owner.resolve(account, sessionId) : { status: 404, error: tr('unknown account') };
  }
}
