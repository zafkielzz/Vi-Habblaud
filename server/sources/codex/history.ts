// Codex terminal history (HistoryProvider 'codex', see sources/source.ts): recent conversations for each
// Codex account (open or already terminated), listed from rollouts in sessions/YYYY/MM/DD/ and
// archived_sessions/ modified in the last 7 days. Reads only the beginning of each file (session_meta: project;
// and first instruction: title) and the end (last activity), cached while mtime and size remain unchanged.
// Subagents and internal threads (guardian, review...) are excluded, like Claude Code subagents.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { parseRolloutName, rolloutDirs } from './files';
import { createCodexState, isThreadId, metaFromLine, parseRolloutLine, type RolloutMeta } from './rollout';
import { createCodexTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Beginning read from each rollout (session_meta usually fits; otherwise reads more, up to META_MAX). */
const HEAD_BYTES = 64 * 1024;
const META_MAX = 1024 * 1024;
/** Chunk after session_meta where the first instruction is searched. */
const PROMPT_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const READ_CONCURRENCY = 8;

export interface CodexHistoryAccount {
  id: string;
  /** Codex directory read by this process (in Docker, the mounted path). */
  dir: string;
}

export interface CodexHistoryOptions {
  accounts: () => readonly CodexHistoryAccount[];
  /** Primary agent of the session, if still open in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

/** What the beginning and end of the rollout reveal about the conversation. */
export interface RolloutSummary {
  meta?: RolloutMeta;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  threadId: string;
  path: string;
  dir: string;
  mtimeMs: number;
  size: number;
}

export class CodexHistory implements HistoryProvider {
  readonly provider = 'codex' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: RolloutSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: CodexHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) all.push(...(await this.candidates(acc, now)));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const summaries = await mapLimit(picked, READ_CONCURRENCY, (c) => this.summaryOf(c));
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const s = summaries[i];
      // Subagents and internal threads are not user conversations.
      if (s.meta?.internal || s.meta?.parentThreadId) return;
      const agentId = this.opts.openAgentOf(c.account, c.threadId);
      if (!agentId && s.firstAt === undefined && s.lastAt === undefined) return;
      const cwd = s.meta?.cwd;
      const r: RecentSession = {
        account: c.account,
        provider: 'codex',
        sessionId: c.threadId,
        projectDir: cwd ? encodeCwd(cwd) : relative(c.dir, join(c.path, '..')) || 'sessions',
        lastAt: s.lastAt ?? c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (cwd) r.project = cwd;
      if (s.title) r.title = s.title;
      if (s.firstAt !== undefined) r.firstAt = s.firstAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Rollout for thread `sessionId` of account, validated: known account, id formatted as UUID, and file (with
   * symlinks resolved) inside account directory. Rollout that is only compressed (.jsonl.zst) cannot be read yet: 404.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isThreadId(sessionId)) return { status: 400, error: tr('invalid session id') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('unknown account') };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: tr('session not found') };
    }
    const id = sessionId.toLowerCase();
    let best: { path: string; mtimeMs: number } | undefined;
    let compressed = false;
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.threadId !== id) continue;
        if (r.compressed) {
          compressed = true;
          continue;
        }
        try {
          const real = realpathSync(join(dir, name));
          // Symlink pointing outside account directory is ignored.
          if (!real.startsWith(root + sep)) continue;
          const st = statSync(real);
          if (!st.isFile()) continue;
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: real, mtimeMs: st.mtimeMs };
        } catch {
          // disappeared between listing and read
        }
      }
    }
    if (best) return { path: best.path, createParser: createCodexTerminalParser };
    return { status: 404, error: compressed ? tr("session compressed by Codex (.zst): can't be read yet") : tr('session not found') };
  }

  /** Rollouts (one per thread: most recent) modified within the window. */
  private async candidates(acc: CodexHistoryAccount, now: number): Promise<Candidate[]> {
    const byThread = new Map<string, Candidate>();
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.compressed) continue;
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
          const prev = byThread.get(r.threadId);
          if (!prev || st.mtimeMs > prev.mtimeMs) byThread.set(r.threadId, { account: acc.id, threadId: r.threadId, path, dir: acc.dir, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // deleted during listing
        }
      }
    }
    return [...byThread.values()];
  }

  private async summaryOf(c: Candidate): Promise<RolloutSummary> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.summary;
    let summary: RolloutSummary;
    try {
      summary = await readRolloutSummary(c.path, c.size);
    } catch (err) {
      log.warnOnce(`codex-history:${errMsg(err)}`, tr('Codex history: unreadable rollout ({0}).', [errMsg(err)]));
      summary = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, summary });
    return summary;
  }
}

/** Reads beginning and end of rollout (of size `size`): session_meta, first instruction, and timestamps. */
export async function readRolloutSummary(path: string, size: number): Promise<RolloutSummary> {
  const fh = await open(path, 'r');
  try {
    const read = async (start: number, length: number): Promise<Buffer> => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    };
    let head = await read(0, HEAD_BYTES);
    let nl = head.indexOf(0x0a);
    // large session_meta (base instructions, tools): read more, up to META_MAX.
    while (nl === -1 && head.length < Math.min(size, META_MAX)) {
      const more = await read(head.length, HEAD_BYTES * 4);
      if (!more.length) break;
      head = Buffer.concat([head, more]);
      nl = head.indexOf(0x0a);
    }
    const summary: RolloutSummary = {};
    const firstLine = head.toString('utf8', 0, nl === -1 ? head.length : nl);
    const meta = metaFromLine(firstLine);
    if (meta) summary.meta = meta;
    const state = createCodexState(meta);
    const ctx = { idPrefix: '', now: 0, activities: false };
    if (nl !== -1) {
      const after = await read(nl + 1, PROMPT_BYTES);
      const lines = after.toString('utf8').split('\n');
      if (nl + 1 + after.length < size) lines.pop(); // truncated
      for (const line of lines) {
        if (!line.trim()) continue;
        parseRolloutLine(state, line, ctx);
        if (state.title !== undefined) break;
      }
    }
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = (await read(tailStart, TAIL_BYTES)).toString('utf8').split('\n');
    if (tailStart > 0) tail.shift(); // truncated
    for (const line of tail) {
      const at = /"timestamp":"([^"]+)"/.exec(line.slice(0, 200))?.[1];
      const ms = at ? Date.parse(at) : NaN;
      if (!Number.isNaN(ms) && (summary.lastAt === undefined || ms > summary.lastAt)) summary.lastAt = ms;
    }
    const first = meta?.startedAt ?? state.firstAt;
    if (first !== undefined) summary.firstAt = first;
    if (summary.lastAt === undefined && state.lastAt !== undefined) summary.lastAt = state.lastAt;
    if (state.title) summary.title = state.title;
    return summary;
  } finally {
    await fh.close();
  }
}

/** Asynchronous map() with at most `limit` concurrent tasks (preserves order). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
