// Claude Code terminal history (HistoryProvider 'claude', see sources/source.ts): recent sessions
// for each account (open or already closed), listed from transcripts
// <config>/projects/<project>/<sessionId>.jsonl (in Docker, the projects/ folder of each account mounted read-only).
// Reads only the start (project, first activity, and first prompt) and end (title and last activity) of each file,
// never the entire file, and caches results while mtime and size remain unchanged.
// Subagents (<session>/subagents/) are excluded.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { truncate } from '../../shared/activity';
import type { AgentInfo, RecentSession } from '../../shared/types';
import { errMsg, log } from '../log';
import type { HistoryProvider, HistoryResolveResult } from './source';
import { sessionDirOf } from './subagents';
import { createTerminalParser } from './terminal';
import { createTranscriptState, parseLine, titleOf } from './transcript';
import { readCustomTitleFile } from './watcher';
import { tr } from '../../shared/i18n';

/** Listing window: sessions with transcript modified in last 7 days. */
export const HISTORY_DAYS = 7;
export const HISTORY_MAX_AGE_MS = HISTORY_DAYS * 24 * 3600_000;
/** Maximum listed sessions (most recent ones). */
export const HISTORY_LIMIT = 150;
/** File start read: project (cwd), first activity, and first prompt. */
export const HEAD_BYTES = 64 * 1024;
/** File end read: Claude Code rewrites title and last prompt each turn, so they reside near end. */
export const TAIL_BYTES = 64 * 1024;
/** No title in last 64 KB (e.g. huge result at end of file): searches in larger chunk, once. */
export const TAIL_RETRY_BYTES = 512 * 1024;
/** Concurrently read files (listing is asynchronous: does not block office polling). */
const READ_CONCURRENCY = 8;
const TITLE_MAX = 90;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lines giving title to session (same compact format transcript.ts searches in prefix). */
const TITLE_MARKERS = ['"type":"custom-title"', '"type":"agent-name"', '"type":"ai-title"', '"type":"last-prompt"'];

/** Claude Code session ID is a UUID (also transcript filename). */
export function isSessionId(v: string): boolean {
  return SESSION_ID.test(v);
}

export interface HistoryAccount {
  id: string;
  /** Config dir read by this process (in Docker, mounted path). */
  dir: string;
}

export interface HistoryOptions {
  accounts: () => readonly HistoryAccount[];
  /** Main session agent, if still open in office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

/** What the start and end of the transcript say about the session. */
export interface SessionMeta {
  project?: string;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

interface Candidate {
  account: string;
  sessionId: string;
  projectDir: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Result of resolve(): transcript path (with Claude Code terminal parser) or HTTP error. */
export type ResolveResult = HistoryResolveResult;

/** Main agent (still in office and not closed) for session `sessionId` of account. */
export function openMainAgent(agents: readonly AgentInfo[], account: string, sessionId: string): string | undefined {
  return agents.find((a) => a.kind === 'main' && a.account === account && a.sessionId === sessionId && a.status !== 'offline')?.id;
}

export class SessionHistory implements HistoryProvider {
  readonly provider = 'claude' as const;
  /** Metadata per path, valid while mtime and size match. */
  private cache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;
  /** Actually read files (without cache) since start: for tests only. */
  reads = 0;

  constructor(private readonly opts: HistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  /** Recent sessions from all accounts, from newest activity to oldest. */
  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) all.push(...(await this.candidates(acc, now)));
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const metas = await mapLimit(picked, READ_CONCURRENCY, (c) => this.metaOf(c));
    // Drop files that fell out of window (cache does not grow unbounded).
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const meta = metas[i];
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      // No line with timestamp (session opened and closed with no conversation): nothing to show.
      if (!agentId && meta.firstAt === undefined && meta.lastAt === undefined) return;
      const s: RecentSession = {
        account: c.account,
        sessionId: c.sessionId,
        projectDir: c.projectDir,
        lastAt: meta.lastAt ?? c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (meta.project) s.project = meta.project;
      if (meta.title) s.title = meta.title;
      if (meta.firstAt !== undefined) s.firstAt = meta.firstAt;
      if (agentId) s.agentId = agentId;
      out.push(s);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Validated transcript of account session `sessionId`: account must be known, ID must
   * be UUID format, and resolved file must reside inside account's projects/ directory.
   */
  resolve(account: string, sessionId: string): ResolveResult {
    if (!isSessionId(sessionId)) return { status: 400, error: tr('invalid session id') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('unknown account') };
    const projects = join(acc.dir, 'projects');
    const notFound: ResolveResult = { status: 404, error: tr('session not found') };
    let root: string;
    let dirs: string[];
    try {
      root = realpathSync(projects);
      dirs = readdirSync(projects);
    } catch {
      return notFound;
    }
    const name = `${sessionId}.jsonl`;
    for (const d of dirs) {
      const candidate = join(projects, d, name);
      if (!existsSync(candidate)) continue;
      try {
        const real = realpathSync(candidate);
        // Symlink inside projects/ pointing outside is rejected.
        if (!real.startsWith(root + sep) || !statSync(real).isFile()) continue;
        return { path: real, createParser: createTerminalParser };
      } catch {
        // disappeared between listing and reading
      }
    }
    return notFound;
  }

  /** Top-level transcripts (one per session) modified within window. */
  private async candidates(acc: HistoryAccount, now: number): Promise<Candidate[]> {
    const projects = join(acc.dir, 'projects');
    const out: Candidate[] = [];
    let dirs: string[];
    try {
      dirs = (await readdir(projects, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out; // account has no projects/ (yet)
    }
    for (const projectDir of dirs) {
      let names: string[];
      try {
        names = await readdir(join(projects, projectDir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!isSessionId(sessionId)) continue;
        const path = join(projects, projectDir, name);
        try {
          const st = await stat(path);
          if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
          out.push({ account: acc.id, sessionId, projectDir, path, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // deleted during listing
        }
      }
    }
    return out;
  }

  private async metaOf(c: Candidate): Promise<SessionMeta> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.meta;
    let meta: SessionMeta;
    try {
      this.reads++;
      meta = await readSessionMeta(c.path, c.size);
    } catch (err) {
      log.warnOnce(`history:${errMsg(err)}`, tr('Session history: unreadable transcript ({0}).', [errMsg(err)]));
      meta = {};
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, meta });
    return meta;
  }
}

/** Reads transcript start and end (of `size`) and extracts project, title, and timestamps. */
export async function readSessionMeta(path: string, size: number): Promise<SessionMeta> {
  const fh = await open(path, 'r');
  try {
    const read = async (start: number, length: number): Promise<string> => {
      const buf = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.toString('utf8', 0, bytesRead);
    };
    let head: string[];
    let tail: string[];
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      head = tail = splitLines(await read(0, size), false, false);
    } else {
      // Last line of head and first line of tail are truncated: discard them.
      head = splitLines(await read(0, HEAD_BYTES), false, true);
      tail = splitLines(await read(size - TAIL_BYTES, TAIL_BYTES), true, false);
    }
    const state = createTranscriptState();
    const ctx = { idPrefix: '', now: 0, activities: false };
    for (const line of head) parseLine(state, line, ctx);
    if (tail !== head) for (const line of tail) parseLine(state, line, ctx);
    const meta: SessionMeta = {};
    if (state.firstAt !== undefined) meta.firstAt = state.firstAt;
    if (state.lastAt !== undefined) meta.lastAt = state.lastAt;
    const project = projectOf(head);
    if (project) meta.project = project;

    // As in watcher: transcript /rename takes precedence; session custom-title.json covers what tail lacked.
    state.customTitle ??= readCustomTitleFile(sessionDirOf(path));
    // Tail brought no title line (e.g. huge result at the very end): search a bit earlier.
    if (size > HEAD_BYTES + TAIL_BYTES && !tail.some(isTitleLine) && !(state.customTitle ?? state.agentName ?? state.aiTitle)) {
      const len = Math.min(TAIL_RETRY_BYTES, size - HEAD_BYTES);
      for (const line of splitLines(await read(size - len, len), true, false)) if (isTitleLine(line)) parseLine(state, line, ctx);
    }
    const title = titleOf(state) ?? firstPrompt(head);
    if (title) meta.title = title;
    return meta;
  } finally {
    await fh.close();
  }
}

function isTitleLine(line: string): boolean {
  return TITLE_MARKERS.some((m) => line.includes(m));
}

function splitLines(text: string, dropFirst: boolean, dropLast: boolean): string[] {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  return lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
}

/** `cwd` from first line that includes it (conversation lines contain project directory). */
function projectOf(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
    } catch {
      // invalid line: try next
    }
  }
  return undefined;
}

/** When no title in transcript: first prompt (already cleaned and masked by terminal parser). */
function firstPrompt(lines: readonly string[]): string | undefined {
  const parser = createTerminalParser();
  for (const line of lines) {
    let entries;
    try {
      entries = parser.push(line);
    } catch {
      continue;
    }
    const user = entries.find((e) => e.kind === 'user');
    if (user?.kind === 'user' && user.text.trim()) return truncate(user.text, TITLE_MAX);
  }
  return undefined;
}

/** Async map() with at most `limit` concurrent tasks (preserves order). */
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
