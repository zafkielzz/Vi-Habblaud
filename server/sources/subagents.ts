// Session subagent files:
//   <project>/<sessionId>/subagents/agent-<agentId>.jsonl (+ .meta.json)
//   <project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl (+ .meta.json, journal.jsonl)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export interface SubagentFile {
  agentId: string;
  path: string;
  metaPath: string;
  /** Workflow run owning the subagent (folder subagents/workflows/<runId>/). */
  runId?: string;
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  workflowPhase?: string;
}

/** No writes for 5 s after an end_turn: concluded. */
export const END_TURN_QUIET_MS = 5_000;
/** No writes for 120 s: concluded (or stuck). */
export const IDLE_TIMEOUT_MS = 120_000;
/** With a tool running (e.g. long command), wait longer before giving up. */
export const PENDING_TOOL_TIMEOUT_MS = 600_000;
/** On boot, only subagents written within the last 90 s are included. */
export const BOOT_RECENT_MS = 90_000;

const AGENT_FILE = /^agent-([\w-]+)\.jsonl$/;

/** Session data folder (sibling of the transcript <sessionId>.jsonl). */
export function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, '');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function listSubagentFiles(sessionDir: string): SubagentFile[] {
  const out: SubagentFile[] = [];
  const base = join(sessionDir, 'subagents');
  const collect = (dir: string, runId?: string) => {
    for (const name of listDir(dir)) {
      const m = AGENT_FILE.exec(name);
      if (!m) continue;
      const file: SubagentFile = { agentId: m[1], path: join(dir, name), metaPath: join(dir, `agent-${m[1]}.meta.json`) };
      if (runId) file.runId = runId;
      out.push(file);
    }
  };
  collect(base);
  for (const runId of listDir(join(base, 'workflows'))) collect(join(base, 'workflows', runId), runId);
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseSubagentMeta(raw: string): SubagentMeta | undefined {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return undefined;
    const meta: SubagentMeta = {};
    const agentType = str(j.agentType);
    const description = str(j.description);
    const toolUseId = str(j.toolUseId);
    const requestShape = str(j.requestShape);
    const workflowPhase = str(j.workflowPhase);
    if (agentType) meta.agentType = agentType;
    if (description) meta.description = description;
    if (toolUseId) meta.toolUseId = toolUseId;
    if (typeof j.spawnDepth === 'number') meta.spawnDepth = j.spawnDepth;
    if (requestShape) meta.requestShape = requestShape;
    if (workflowPhase) meta.workflowPhase = workflowPhase;
    return meta;
  } catch {
    return undefined;
  }
}

export function readSubagentMeta(metaPath: string): SubagentMeta | undefined {
  try {
    return parseSubagentMeta(readFileSync(metaPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface JournalAgent {
  label?: string;
  done: boolean;
}

const JOURNAL_DONE = /^(completed?|finished|done|failed|errored|error|killed|cancell?ed|stopped|succeeded|result)$/i;

/** Workflow journal.jsonl: label for each agent and which ones have finished. */
export function parseJournal(text: string): Map<string, JournalAgent> {
  const out = new Map<string, JournalAgent>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const agentId = str(j.agentId);
    const type = str(j.type);
    if (!agentId || !type) continue;
    const cur = out.get(agentId) ?? { done: false };
    const label = str(j.label);
    if (label) cur.label = label;
    if (JOURNAL_DONE.test(type)) cur.done = true;
    out.set(agentId, cur);
  }
  return out;
}

/** Display role for the subagent. */
export function subagentRole(meta: SubagentMeta | undefined, spawnType?: string): string {
  const t = meta?.agentType ?? spawnType;
  if (!t) return tr('Subagent');
  if (t === 'workflow-subagent') return 'Workflow';
  return t;
}

export interface IdleCheck {
  now: number;
  lastWriteAt: number;
  /** The subagent's last message finished with end_turn. */
  ended: boolean;
  /** A tool was called without a result yet. */
  pendingTool: boolean;
}

/** Inactivity conclusion: end_turn + 5 s of silence, or prolonged silence. */
export function concludedByIdle(c: IdleCheck): boolean {
  const quiet = c.now - c.lastWriteAt;
  if (c.ended && !c.pendingTool && quiet >= END_TURN_QUIET_MS) return true;
  return quiet >= (c.pendingTool ? PENDING_TOOL_TIMEOUT_MS : IDLE_TIMEOUT_MS);
}
