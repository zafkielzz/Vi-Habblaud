// Reads how a worker's turn went from its conversation file, never from the screen: the boss only ever gets the final
// answer (server/workers/service.ts).
//
// - Antigravity: <profile>/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl, one
//   step per line ({type: USER_INPUT | PLANNER_RESPONSE | GENERIC | ..., status, content, tool_calls?, input_tokens,
//   output_tokens}), written live. The turn is over when the last step is a PLANNER_RESPONSE without tool calls; its
//   content is the answer.
// - Claude Code: <config>/projects/<cwd>/<session>.jsonl. The turn is over when the last assistant message stopped with
//   `end_turn` and no tool is pending; the answer is the text of that message.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TurnState {
  /** The prompts typed so far (USER_INPUT steps / real user messages). */
  prompts: number;
  /** The last turn is over. */
  ended: boolean;
  /** Final answer of the last turn (only when ended). */
  answer?: string;
  /**
   * Tokens of the model calls since the last prompt: input + output, and for Claude Code also the cached prompt read
   * and written (most of a job's tokens: input_tokens alone leaves out everything served from the cache).
   */
  tokens: number;
  /** Claude Code: the same tokens by kind, for the log. */
  usage?: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
}

/** Transcript of an Antigravity conversation. */
export function agyTranscriptPath(stateDir: string, conversation: string): string {
  return join(stateDir, 'brain', conversation, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * The newest write of an account's agy (epoch ms; 0 = none found): its conversation databases, which agy-ask deletes
 * after each call so only live ones and a few old ones are there, their transcripts and the run's log.
 */
export function lastWrite(stateDir: string, cliLog?: string): number {
  let newest = 0;
  const see = (path: string) => {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      // not written yet, or just deleted
    }
  };
  if (cliLog) see(cliLog);
  const dir = join(stateDir, 'conversations');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return newest;
  }
  for (const name of names) {
    see(join(dir, name));
    const conv = /^(.+)\.db$/.exec(name)?.[1];
    if (conv) see(agyTranscriptPath(stateDir, conv));
  }
  return newest;
}

/** Transcript of a Claude Code session (cwd encoded like Claude Code does). */
export function claudeTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * Whether a Claude Code account trusts a folder (it or a parent accepted in the "trust this folder?" dialog, recorded
 * in <config>/.claude.json, or ~/.claude.json for the default ~/.claude). An interactive claude in a folder it does
 * not trust stops at that dialog before reading the prompt. undefined when the file cannot be read.
 */
export function claudeTrusts(configDir: string, isDefault: boolean, cwd: string): boolean | undefined {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }>;
  try {
    const file = isDefault ? join(dirname(configDir), '.claude.json') : join(configDir, '.claude.json');
    projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects?: typeof projects }).projects ?? {};
  } catch {
    return undefined;
  }
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted === true) return true;
    if (dirname(dir) === dir) return false;
  }
}

function lines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const j = JSON.parse(raw) as unknown;
      if (j && typeof j === 'object') out.push(j as Record<string, unknown>);
    } catch {
      // a line being written: read again next time
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);

export function agyTurn(text: string): TurnState {
  const steps = lines(text);
  let prompts = 0;
  let tokens = 0;
  for (const s of steps) {
    if (s.type === 'USER_INPUT') {
      prompts++;
      tokens = 0;
    } else if (s.type === 'PLANNER_RESPONSE') tokens += num(s.input_tokens) + num(s.output_tokens);
  }
  const last = steps.at(-1);
  const toolCalls = last?.tool_calls;
  const ended =
    prompts > 0 && last?.type === 'PLANNER_RESPONSE' && last.status === 'DONE' && !(Array.isArray(toolCalls) ? toolCalls.length : toolCalls);
  const st: TurnState = { prompts, ended, tokens };
  if (ended && typeof last?.content === 'string') st.answer = last.content.trim();
  return st;
}

/** A real prompt (not a tool result or a command echo). */
function isPrompt(j: Record<string, unknown>): boolean {
  if (j.type !== 'user' || j.isMeta) return false;
  const c = (j.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command');
  return Array.isArray(c) && c.some((b) => (b as { type?: string }).type === 'text');
}

export function claudeTurn(text: string): TurnState {
  let prompts = 0;
  const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });
  let usage = zero();
  let ended = false;
  let answer: string | undefined;
  const pending = new Set<string>();
  // One assistant message is written as several lines (one per block) carrying the same usage: count it once.
  const counted = new Set<string>();
  for (const j of lines(text)) {
    if (isPrompt(j)) {
      prompts++;
      usage = zero();
      ended = false;
      answer = undefined;
      continue;
    }
    const m = j.message as { id?: unknown; content?: unknown; stop_reason?: unknown; usage?: Record<string, unknown> } | undefined;
    const blocks = Array.isArray(m?.content) ? (m!.content as Array<Record<string, unknown>>) : [];
    if (j.type === 'user') {
      for (const b of blocks) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') pending.delete(b.tool_use_id);
      continue;
    }
    if (j.type !== 'assistant' || !m) continue;
    const mid = typeof m.id === 'string' ? m.id : '';
    if (!mid || !counted.has(mid)) {
      const u = m.usage;
      usage.input_tokens += num(u?.input_tokens);
      usage.output_tokens += num(u?.output_tokens);
      usage.cache_read_tokens += num(u?.cache_read_input_tokens);
      usage.cache_creation_tokens += num(u?.cache_creation_input_tokens);
    }
    if (mid) counted.add(mid);
    for (const b of blocks) if (b.type === 'tool_use' && typeof b.id === 'string') pending.add(b.id);
    const said = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n').trim();
    if (said) answer = said;
    ended = m.stop_reason === 'end_turn' && pending.size === 0;
  }
  const tokens = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_creation_tokens;
  const st: TurnState = { prompts, ended: prompts > 0 && ended, tokens, usage };
  if (st.ended && answer) st.answer = answer;
  return st;
}
