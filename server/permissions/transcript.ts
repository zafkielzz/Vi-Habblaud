// Request answered directly in the terminal: Claude Code displays the permission dialog at the same time
// it runs the hook, and when answered there, it does NOT terminate the hook (which would keep waiting until
// timeout). To remove the request from the office, the registry searches the end of the transcript for the tool
// call of the request (the hook does not receive tool_use id, so search is by name + argument signature)
// and waits for its tool_result: approved (tool ran) or denied (error result).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** How much of the end of the transcript is read on each check. */
export const SCAN_TAIL_BYTES = 512 * 1024;
/** Calls older than this (before the request) are not candidates: they belong to previous turns. */
export const MAX_CALL_AGE_MS = 10 * 60_000;
/** Truncation length for signature texts (the hook also truncates long arguments before sending). */
const SIG_TEXT_MAX = 2_000;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function cut(v: unknown): unknown {
  if (typeof v === 'string') return v.length > SIG_TEXT_MAX ? v.slice(0, SIG_TEXT_MAX) : v;
  if (Array.isArray(v)) return v.map(cut);
  const r = rec(v);
  if (!r) return v;
  const out: Rec = {};
  for (const k of Object.keys(r).sort()) out[k] = cut(r[k]);
  return out;
}

/**
 * Signature of a tool call, identical for the hook's `tool_input` and the `input` of tool_use
 * in the transcript. Known tools use only the primary argument (Claude Code may fill optional
 * fields before calling the hook); other tools use all arguments (sorted keys, truncated
 * text).
 */
export function callSignature(tool: string, input: unknown): string {
  const r = rec(input) ?? {};
  const s = (k: string) => (typeof r[k] === 'string' ? (cut(r[k]) as string) : '');
  switch (tool) {
    case 'Bash':
      return `Bash|${s('command')}`;
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'LS':
      return `${tool}|${s('file_path') || s('notebook_path') || s('path')}`;
    case 'WebFetch':
      return `WebFetch|${s('url')}`;
    case 'WebSearch':
      return `WebSearch|${s('query')}`;
    case 'Glob':
    case 'Grep':
      return `${tool}|${s('pattern')}|${s('path')}`;
    default:
      return `${tool}|${JSON.stringify(cut(r))}`;
  }
}

/** Reads the last `bytes` of the file (the first line, possibly truncated, is discarded). */
function readTail(path: string, bytes: number): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

export interface CallScan {
  /** Tool call of the request found in the transcript (the most recent that matches and had no result yet). */
  toolUseId?: string;
  /** Call already has a tool_result: request was answered (in the terminal, or session proceeded without it). */
  answered: boolean;
}

/**
 * Searches for the request's call at the end of the transcript. With `knownId` (found previously), only checks
 * if the result arrived. Without it, selects the most recent call with matching name and signature that had no
 * result yet and is not from long before the request. Unreadable file: throws (caller ignores).
 */
export function scanToolCall(
  path: string,
  q: { tool: string; signature: string; knownId?: string; createdAt: number },
  tailBytes = SCAN_TAIL_BYTES,
): CallScan {
  const calls: Array<{ id: string; at: number }> = [];
  const results = new Set<string>();
  for (const line of readTail(path, tailBytes)) {
    // Cheap filter before JSON.parse: only lines with tool_use or tool_result are relevant.
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const content = rec(j?.message)?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof j?.timestamp === 'string' ? Date.parse(j.timestamp) : Number.NaN;
    for (const raw of content) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') results.add(b.tool_use_id);
      else if (b.type === 'tool_use' && typeof b.id === 'string' && !q.knownId && b.name === q.tool && callSignature(q.tool, b.input) === q.signature) {
        calls.push({ id: b.id, at });
      }
    }
  }
  if (q.knownId) return { toolUseId: q.knownId, answered: results.has(q.knownId) };
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (results.has(c.id)) continue;
    if (Number.isFinite(c.at) && c.at < q.createdAt - MAX_CALL_AGE_MS) break;
    return { toolUseId: c.id, answered: false };
  }
  return { answered: false };
}
