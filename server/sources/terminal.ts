// Full transcript view for the terminal: converts Claude Code JSONL lines
// into TerminalEntry (prompts, responses, tools, and their results), with secrets masked and
// texts truncated. Independent of the activity parser (transcript.ts): here the goal is to show the
// conversation as Claude Code displays it, not summarize what the character is doing.
//
// What the transcripts provide (structure only) shaping the rules below:
// - each assistant line brings ONE block (thinking, text, or tool_use); the same message (message.id)
//   spans multiple lines. Thinking is almost always empty (only the signature);
// - a prompt typed while the agent is busy arrives as a queued_command attachment (commandMode
//   'prompt'), not as a user line; background task notifications arrive as a user line or
//   as a queued_command attachment (queue-operation lines are just the queue and are ignored);
// - local slash commands and their output come in local_command system lines;
// - API errors: one api_error system line per attempt and, when Claude Code gives up, a
//   synthetic assistant message with isApiErrorMessage.
import type { TerminalEntry, TerminalInputKind } from '../../shared/types';
import { formatDuration, maskSecrets, truncate } from '../../shared/activity';
import { forkDirective, parseTaskNotification } from './transcript';
import { tr } from '../../shared/i18n';

export interface TerminalParser {
  /** Parses a JSONL line. Invalid or irrelevant lines return []. */
  push(line: string): TerminalEntry[];
}

// ------------------------------------------------------------------ limits (characters)

/** User prompts and agent responses. */
export const TEXT_MAX = 20_000;
export const THINKING_MAX = 8_000;
/** Arguments of a tool (command, diff, JSON...). */
export const INPUT_MAX = 2_000;
/** Tool result: characters and lines (anything exceeding this gets `truncated`). */
export const RESULT_MAX = 4_000;
export const RESULT_MAX_LINES = 120;
/** Detail of a 'system' entry (command output, compaction summary...). */
export const DETAIL_MAX = 4_000;
/** Argument displayed in a tool's title: "Bash(…)". */
export const TITLE_ARG_MAX = 100;
/** Text (one line) of a 'system' entry. */
const SYSTEM_TEXT_MAX = 200;
/**
 * When clipping text BEFORE masking (to avoid running regexes over megabytes that won't be
 * shown), the end of the slice could contain half a secret that regexes miss: those trailing
 * characters are discarded.
 */
const TAIL_GUARD = 256;
/** Emitted IDs that are remembered (duplicates are local: same repeated line or message). */
const SEEN_MAX = 20_000;
const MSG_BLOCKS_MAX = 64;

type Rec = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type ThinkingEntry = Extract<TerminalEntry, { kind: 'thinking' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

// ------------------------------------------------------------------ text: cleaning, masking, and clipping

const REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
// ANSI sequences (colors, cursor, OSC titles) and other control characters, except \t and \n.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strips system reminders (optional), ANSI colors, and what \r in progress bars overwrote. */
function clean(s: string, reminders: boolean): string {
  let out = reminders && s.includes('<system-reminder>') ? s.replace(REMINDER, '') : s;
  if (out.includes('\x1b')) out = out.replace(ANSI, '');
  if (out.includes('\r')) {
    out = out
      .replace(/\r+\n/g, '\n')
      .split('\n')
      .map((l) => {
        const i = l.replace(/\r+$/, '').lastIndexOf('\r');
        return i >= 0 ? l.slice(i + 1) : l.replace(/\r+$/, '');
      })
      .join('\n');
  }
  return out.replace(CONTROL, '');
}

/**
 * Cleans and masks at most `window` characters of `raw`. `cut` = the original text was larger (and the end
 * of the slice, where half a secret might exist, was discarded). Any subsequent clipping is safe.
 */
function safeText(raw: string, window: number, reminders = true): { text: string; cut: boolean } {
  if (raw.length <= window) return { text: maskSecrets(clean(raw, reminders)), cut: false };
  const masked = maskSecrets(clean(raw.slice(0, window), reminders));
  return { text: masked.slice(0, Math.max(0, masked.length - TAIL_GUARD)), cut: true };
}

/** Clips already masked text to `max` characters and `maxLines` lines, preserving line breaks. */
function clip(s: string, max: number, maxLines = Infinity): { text: string; truncated: boolean } {
  let end = Math.min(s.length, max);
  if (maxLines !== Infinity) {
    let nl = -1;
    for (let n = 0; n < maxLines; n++) {
      nl = s.indexOf('\n', nl + 1);
      if (nl === -1 || nl >= end) break;
    }
    if (nl !== -1 && nl < end) end = nl;
  }
  if (end >= s.length) return { text: s, truncated: false };
  // Do not cut a surrogate pair (emoji) in half.
  const code = s.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return { text: s.slice(0, end).trimEnd(), truncated: true };
}

export interface Prepared {
  text: string;
  truncated: boolean;
}

/**
 * Multiline text ready to display: cleaned, masked, trimmed, and clipped. Also used by the
 * Codex terminal (sources/codex/terminal.ts), like `marked` and `oneLine`.
 */
export function prepare(raw: string, max: number, maxLines = Infinity, reminders = true): Prepared {
  const safe = safeText(raw, max * 2 + 1_024, reminders);
  const c = clip(safe.text.replace(/^(?:[ \t]*\n)+/, '').trimEnd(), max, maxLines);
  return { text: c.text, truncated: c.truncated || safe.cut };
}

/** For entries without the `truncated` field: clipping becomes a trailing "…" line. */
export function marked(p: Prepared): string {
  return p.truncated && p.text ? `${p.text}\n…` : p.text;
}

/** First non-empty line, masked and clipped to `max` (with " …" if there were more lines). */
export function oneLine(raw: string, max: number, reminders = true): string {
  const { text, cut } = safeText(raw, max * 4 + TAIL_GUARD * 2, reminders);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return '';
  const line = truncate(lines[i], max);
  const more = cut || lines.slice(i + 1).some((l) => l.trim());
  return more && !line.endsWith('…') ? `${line} …` : line;
}

/** One line for the `text` of a 'system' entry and, if it lost information, the full text in `detail`. */
function lineAndDetail(raw: string, max = SYSTEM_TEXT_MAX): { line: string; detail?: string } {
  const line = oneLine(raw, max);
  return line.endsWith('…') ? { line, detail: raw } : { line };
}

/** `<tag>content</tag>` (the first). */
const TAGS = new Map<string, RegExp>();
function inner(text: string, tag: string): string | undefined {
  let re = TAGS.get(tag);
  if (!re) TAGS.set(tag, (re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)));
  return re.exec(text)?.[1];
}

// ------------------------------------------------------------------ tools

interface ToolView {
  title: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

function relPath(p: string, cwd: string | undefined): string {
  if (!cwd || !p.startsWith('/')) return p;
  const base = cwd.replace(/\/+$/, '');
  if (!base || p === base) return base ? '.' : p;
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
}

function titled(label: string, arg: string | undefined): string {
  const shown = arg ? oneLine(arg, TITLE_ARG_MAX, false) : '';
  return shown ? `${label}(${shown})` : label;
}

/** The argument fits entirely in the title (so it does not need to repeat in JSON). */
function fitsTitle(v: string): boolean {
  return !v.includes('\n') && v.trim().length <= TITLE_ARG_MAX;
}

function textInput(raw: string | undefined, kind: TerminalInputKind = 'text'): Pick<ToolView, 'input' | 'inputKind'> {
  if (!raw?.trim()) return {};
  const input = marked(prepare(raw, INPUT_MAX, Infinity, false));
  return input ? { input, inputKind: kind } : {};
}

/** Indented JSON of arguments, omitting keys already shown in title; empty if nothing remains. */
function jsonInput(input: Rec, omit: readonly string[] = [], cwd?: string): Pick<ToolView, 'input' | 'inputKind'> {
  const restObj: Rec = {};
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (omit.includes(k) || v === undefined || v === null || v === '') continue;
    restObj[k] = k === 'path' && typeof v === 'string' ? relPath(v, cwd) : v;
    n++;
  }
  if (!n) return {};
  let json: string;
  try {
    json = JSON.stringify(restObj, null, 2);
  } catch {
    return {};
  }
  return textInput(json, 'json');
}

/** Prefixes each line ("- " / "+ ") up to `budget` characters; clipping becomes a "<prefix>…" line. */
function prefixLines(text: string, prefix: string, budget: number, sourceCut: boolean): string {
  const src = text.replace(/\n$/, '');
  const out: string[] = [];
  let used = 0;
  let start = 0;
  for (;;) {
    const nl = src.indexOf('\n', start);
    const line = `${prefix}${src.slice(start, nl === -1 ? src.length : nl)}`;
    if (used + line.length > budget) {
      // Line that does not fit (e.g. minified content): show its beginning.
      const room = Math.floor(budget - used);
      out.push(room > prefix.length + 20 ? `${line.slice(0, room).trimEnd()}…` : `${prefix}…`);
      return out.join('\n');
    }
    out.push(line);
    used += line.length + 1;
    if (nl === -1) break;
    start = nl + 1;
  }
  if (sourceCut) out.push(`${prefix}…`);
  return out.join('\n');
}

/** "- old" / "+ new" lines (masked before any clipping). */
function diffText(oldRaw: string, newRaw: string, budget = INPUT_MAX): string {
  const o = oldRaw ? safeText(oldRaw, budget * 2, false) : { text: '', cut: false };
  const n = newRaw ? safeText(newRaw, budget * 2, false) : { text: '', cut: false };
  const newCost = Math.min(budget, Math.ceil(n.text.length * 1.1) + 8);
  const oldPart = o.text ? prefixLines(o.text, '- ', n.text ? Math.max(budget / 2, budget - newCost) : budget, o.cut) : '';
  const newPart = n.text ? prefixLines(n.text, '+ ', Math.max(budget / 4, budget - oldPart.length), n.cut) : '';
  return [oldPart, newPart].filter(Boolean).join('\n');
}

function diffInput(oldRaw: string, newRaw: string): Pick<ToolView, 'input' | 'inputKind'> {
  const text = diffText(oldRaw, newRaw);
  return text ? { input: text, inputKind: 'diff' } : {};
}

const TODO_MARK: Record<string, string> = { completed: '☒', in_progress: '◐', pending: '☐' };
const TASK_STATUS: Record<string, string> = { completed: tr('completed'), in_progress: tr('in progress'), pending: tr('pending'), deleted: 'deleted' };

function todoList(raw: unknown): { list: string; done: number; total: number } {
  const items = Array.isArray(raw) ? raw.map(rec).filter((t): t is Rec => !!t) : [];
  const lines = items.map((t) => `${TODO_MARK[String(t.status)] ?? '☐'} ${str(t.content) ?? str(t.subject) ?? str(t.title) ?? tr('(untitled)')}`);
  return { list: lines.join('\n'), done: items.filter((t) => t.status === 'completed').length, total: items.length };
}

function questionsText(raw: unknown): string {
  const qs = Array.isArray(raw) ? raw.map(rec).filter((q): q is Rec => !!q) : [];
  return qs
    .map((q) => {
      const opts = Array.isArray(q.options) ? q.options.map(rec).filter((o): o is Rec => !!o) : [];
      return [str(q.question) ?? '', ...opts.map((o) => `  - ${str(o.label) ?? ''}${str(o.description) ? `: ${o.description}` : ''}`)].join('\n');
    })
    .join('\n\n');
}

/**
 * Title and arguments of a tool call, in Claude Code style: "Bash(npm test)".
 * Also used by permission requests (server/permissions/).
 */
export function toolView(name: string, input: Rec, cwd?: string): ToolView {
  const s = (k: string) => str(input[k]);
  const path = s('file_path') ?? s('notebook_path') ?? s('path');
  const rel = path ? relPath(path, cwd) : undefined;
  switch (name) {
    case 'Bash':
      return { title: titled('Bash', s('command')), ...textInput(s('command'), 'command') };
    case 'Monitor':
      return { title: titled('Monitor', s('description') ?? s('command')), ...textInput(s('command'), 'command') };
    case 'Read':
    case 'LS':
      return { title: titled(name, rel), ...jsonInput(input, ['file_path', 'path'], cwd) };
    case 'Edit':
      return { title: titled('Edit', rel), ...diffInput(typeof input.old_string === 'string' ? input.old_string : '', typeof input.new_string === 'string' ? input.new_string : '') };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.map(rec).filter((e): e is Rec => !!e) : [];
      const per = Math.max(200, Math.floor(INPUT_MAX / Math.max(1, edits.length)));
      const text = edits
        .slice(0, 12)
        .map((e) => diffText(typeof e.old_string === 'string' ? e.old_string : '', typeof e.new_string === 'string' ? e.new_string : '', per))
        .filter(Boolean)
        .join('\n@@\n');
      return { title: titled('MultiEdit', rel), ...(text ? { input: marked(clip(text, INPUT_MAX)), inputKind: 'diff' as const } : {}) };
    }
    case 'Write':
      return { title: titled('Write', rel), ...diffInput('', typeof input.content === 'string' ? input.content : '') };
    case 'NotebookEdit':
      return { title: titled('NotebookEdit', rel), ...diffInput('', typeof input.new_source === 'string' ? input.new_source : '') };
    case 'Grep':
    case 'Glob':
      return { title: titled(name, s('pattern')), ...jsonInput(input, ['pattern'], cwd) };
    case 'WebFetch':
      return { title: titled('WebFetch', s('url')), ...textInput(s('prompt')) };
    case 'WebSearch':
      return { title: titled('WebSearch', s('query')), ...jsonInput(input, ['query'], cwd) };
    case 'Agent':
    case 'Task': {
      const type = s('subagent_type');
      const desc = s('description');
      const arg = type && desc ? `${type}: ${desc}` : (desc ?? type);
      return { title: titled(name, arg), ...textInput(s('prompt')) };
    }
    case 'TodoWrite': {
      const t = todoList(input.todos);
      return { title: t.total ? tr('TodoWrite({0}/{1} done)', [t.done, t.total]) : 'TodoWrite', ...textInput(t.list) };
    }
    case 'TaskCreate':
      return { title: titled('TaskCreate', s('subject')), ...textInput(s('description')) };
    case 'TaskUpdate': {
      const id = s('taskId') ?? (typeof input.taskId === 'number' ? String(input.taskId) : undefined);
      const st = s('status');
      const arg = id ? `#${id}${st ? ` → ${TASK_STATUS[st] ?? st}` : ''}` : st;
      return { title: titled('TaskUpdate', arg), ...jsonInput(input, ['taskId', 'status'], cwd) };
    }
    case 'Skill':
      return { title: titled('Skill', s('skill') ?? s('command')), ...textInput(s('args')) };
    case 'SendMessage':
      return { title: titled('SendMessage', s('to')), ...textInput(s('message') ?? s('content')) };
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? str(rec(input.questions[0])?.question) : undefined;
      return { title: titled('AskUserQuestion', first), ...textInput(questionsText(input.questions)) };
    }
    case 'ExitPlanMode':
      return { title: 'ExitPlanMode', ...textInput(s('plan')) };
    case 'SubagentHandback':
    case 'StructuredOutput':
      return { title: name, ...(s('message') ? textInput(s('message')) : jsonInput(input, [], cwd)) };
    default:
      break;
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__');
    const srv = server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return { title: `${srv} - ${rest.join('__') || '?'} (MCP)`, ...jsonInput(input, [], cwd) };
  }
  // Default: Name(first text argument) + remaining arguments in JSON.
  const first = Object.entries(input).find(([, v]) => typeof v === 'string' && v.trim()) as [string, string] | undefined;
  return { title: titled(name, first?.[1]), ...jsonInput(input, first && fitsTitle(first[1]) ? [first[0]] : [], cwd) };
}

/** Text of a tool_result: string or blocks (text; image → "[image]"; tool reference → name). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const b = rec(raw);
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push(tr('[image]'));
    else if (b.type === 'document') parts.push('[document]');
    else if (b.type === 'tool_reference' && typeof b.tool_name === 'string') parts.push(b.tool_name);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------ parser

const INTERRUPTED = /^\[Request interrupted by user/;
const REJECTED = /doesn't want to proceed|tool use was rejected|user rejected/i;
const NO_RESPONSE = /^No response requested\.?$/;
const OUTPUT_TAGS = ['local-command-stdout', 'local-command-stderr', 'command-stdout', 'command-stderr'] as const;

interface Ctx {
  j: Rec;
  at: number;
  uuid: string;
  cwd?: string;
}

class Parser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private lastAt?: number;
  private seq = 0;
  private readonly seen = new Set<string>();
  /** Text/thinking blocks already seen per message (a repeated message will not duplicate entries). */
  private readonly msgBlocks = new Map<string, Set<string>>();
  /** Last slash command (to label output that follows on the next line). */
  private lastCommand?: string;
  /**
   * Fork transcript: begins with 'fork-context-ref', a COPY of the parent's Agent call and its
   * result along with the fork instruction (after the <fork-boilerplate> block). The copy is not the fork's.
   */
  private fork?: 'expect-spawn' | 'expect-result';
  private inheritedSpawn?: string;

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Line too malformed: keep whatever was already emitted from it; reading continues.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    if (!j) return;
    const ts = toMs(j.timestamp) ?? toMs(rec(j.attachment)?.timestamp);
    if (ts !== undefined) this.lastAt = ts;
    const c: Ctx = { j, at: ts ?? this.lastAt ?? Date.now(), uuid: str(j.uuid) ?? `x${++this.seq}`, cwd: str(j.cwd) };
    switch (j.type) {
      case 'user':
        return this.user(c);
      case 'assistant':
        return this.assistant(c);
      case 'system':
        return this.system(c);
      case 'attachment':
        return this.attachment(c);
      case 'fork-context-ref':
        this.fork = 'expect-spawn';
        return;
      default:
        // summary, file-history-snapshot, queue-operation, custom-title, progress...
        return;
    }
  }

  // ---------------------------------------------------------------- entries

  private userEntry(c: Ctx, raw: string): void {
    const text = marked(prepare(raw, TEXT_MAX));
    if (text) this.emit({ kind: 'user', id: `${c.uuid}:u`, at: c.at, text });
  }

  /** `text` must be a single line (oneLine) or fixed; masking here is the final safeguard. */
  private sys(c: Ctx, text: string, o: { level?: Level; detail?: string; suffix?: string } = {}): void {
    if (!text) return;
    const e: SystemEntry = { kind: 'system', id: `${c.uuid}${o.suffix ?? ':s'}`, at: c.at, text: maskSecrets(text), level: o.level ?? 'info' };
    if (o.detail?.trim()) {
      const detail = marked(prepare(o.detail, DETAIL_MAX));
      if (detail) e.detail = detail;
    }
    this.emit(e);
  }

  /** Free content of a system line: first line in text (with optional prefix), rest in detail. */
  private sysContent(c: Ctx, content: string, level: Level, label?: string, suffix?: string): void {
    if (!content.trim()) return;
    const { line, detail } = lineAndDetail(content, label ? 160 : SYSTEM_TEXT_MAX);
    this.sys(c, label ? `${label}: ${line}` : line, { level, detail, suffix });
  }

  // ---------------------------------------------------------------- user

  private user(c: Ctx): void {
    const j = c.j;
    if (j.isMeta === true) return;
    const content = rec(j.message)?.content;
    if (j.isCompactSummary === true) {
      const text = typeof content === 'string' ? content : resultText(content);
      this.sys(c, tr('Compacted conversation summary'), { detail: text });
      return;
    }
    if (typeof content === 'string') return this.userText(c, content);
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    let images = 0;
    let results = 0;
    let forkResult = false;
    for (const raw of content) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'tool_result') {
        results++;
        if (this.fork === 'expect-result' && str(b.tool_use_id) === this.inheritedSpawn) forkResult = true;
        else this.toolResult(c, b);
      } else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image') images++;
    }
    if (forkResult) {
      // Result of the inherited call ("Fork started…"): fork instruction comes in text. That's its prompt.
      this.fork = undefined;
      const directive = forkDirective(texts.join('\n'));
      if (directive) this.userEntry(c, directive);
      return;
    }
    // Image next to a tool_result belongs to the result; alone (or with text), belongs to prompt.
    if (texts.length || (images && !results)) this.userText(c, texts.join('\n'), results ? 0 : images);
  }

  private userText(c: Ctx, raw: string, images = 0): void {
    const text = (raw.includes('<system-reminder>') ? raw.replace(REMINDER, '') : raw).trim();
    const pics = images ? Array.from({ length: Math.min(images, 10) }, () => tr('[image]')).join(' ') : '';
    if (!text) {
      if (pics) this.userEntry(c, pics);
      return;
    }
    if (text.startsWith('<task-notification>')) return this.notification(c, text);
    if (INTERRUPTED.test(text)) return this.sys(c, tr('Interrupted by user'), { level: 'warn' });
    if (text.startsWith('Caveat:')) return;
    const tag = /^<([a-z][\w-]*)/.exec(text)?.[1];
    switch (tag) {
      case 'command-name':
      case 'command-message':
      case 'command-args': {
        const msg = inner(text, 'command-message')?.trim();
        const name = inner(text, 'command-name')?.trim() || (msg ? `/${msg}` : undefined);
        if (!name) return;
        const cmd = name.startsWith('/') ? name : `/${name}`;
        this.lastCommand = cmd;
        this.userEntry(c, `${cmd} ${inner(text, 'command-args')?.trim() ?? ''}`.trim());
        return;
      }
      case 'local-command-stdout':
      case 'local-command-stderr':
      case 'command-stdout':
      case 'command-stderr': {
        const out = OUTPUT_TAGS.map((t) => inner(text, t)?.trim())
          .filter(Boolean)
          .join('\n');
        if (out) this.sys(c, this.lastCommand ? tr('Output of {0}', [this.lastCommand]) : tr('Command output'), { detail: out });
        return;
      }
      case 'bash-input': {
        // User bash mode ("! command"): output comes on the following line.
        const cmd = inner(text, 'bash-input')?.trim();
        if (cmd) this.userEntry(c, `! ${cmd}`);
        return;
      }
      case 'bash-stdout':
      case 'bash-stderr': {
        const out = [inner(text, 'bash-stdout'), inner(text, 'bash-stderr')]
          .map((x) => x?.trim())
          .filter(Boolean)
          .join('\n');
        this.sys(c, tr('Command output'), { detail: out || tr('(no output)') });
        return;
      }
      case 'scheduled-task': {
        const body = text.replace(/^<scheduled-task\b[^>]*>/, '').replace(/<\/scheduled-task>\s*$/, '');
        if (body.trim()) this.userEntry(c, body);
        return;
      }
      case 'fork-boilerplate': {
        const directive = forkDirective(text);
        if (directive) this.userEntry(c, directive);
        return;
      }
      case 'user-memory-input': {
        const memory = inner(text, 'user-memory-input')?.trim();
        if (memory) this.userEntry(c, `# ${memory}`);
        return;
      }
      case 'local-command-caveat':
      case 'user-prompt-submit-hook':
        return;
      default:
        break;
    }
    // Pasted images already appear in text as "[Image #1]"; without this tag, marker goes at the end.
    this.userEntry(c, pics && !/\[Image\b/.test(text) ? `${text}\n${pics}` : text);
  }

  private notification(c: Ctx, text: string): void {
    const n = parseTaskNotification(text);
    const status = n.status?.toLowerCase();
    const result = inner(text, 'result')?.trim();
    const event = inner(text, 'event')?.trim();
    let label = tr('Background task notification');
    let level: Level = 'info';
    if (status === 'completed') label = tr('Background task completed');
    else if (status === 'failed' || status === 'error') {
      label = tr('Background task failed');
      level = 'warn';
    } else if (status === 'killed' || status === 'stopped' || status === 'cancelled') {
      label = tr('Background task interrupted');
      level = 'warn';
    } else if (event) label = tr('Background task event');
    const summary = n.summary ? oneLine(n.summary, 160) : '';
    const detail = [summary.endsWith('…') ? n.summary : undefined, event, result].filter(Boolean).join('\n\n');
    this.sys(c, summary ? `${label}: ${summary}` : label, { level, detail });
  }

  private toolResult(c: Ctx, b: Rec): void {
    const id = str(b.tool_use_id);
    if (!id) return;
    const error = b.is_error === true;
    let raw = resultText(b.content);
    const wrapped = /^\s*<tool_use_error>/.test(raw) ? inner(raw, 'tool_use_error') : undefined;
    if (wrapped !== undefined) raw = wrapped;
    if (error && REJECTED.test(raw.slice(0, 300))) {
      const feedback = /the user said:\s*([\s\S]*)$/i.exec(raw)?.[1]?.trim();
      raw = feedback ? tr('Denied by the user: {0}', [feedback]) : tr('Denied by the user');
    }
    const p = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${id}:r`, at: c.at, toolUseId: id, text: p.text || tr('(no output)') };
    if (error) e.error = true;
    if (p.truncated) e.truncated = true;
    this.emit(e);
  }

  // ---------------------------------------------------------------- assistant

  /** Message already brought this block (repeated or cumulative lines of the same message). */
  private repeated(msgId: string, key: string): boolean {
    let set = this.msgBlocks.get(msgId);
    if (!set) {
      this.msgBlocks.set(msgId, (set = new Set()));
      if (this.msgBlocks.size > MSG_BLOCKS_MAX) this.msgBlocks.delete(this.msgBlocks.keys().next().value as string);
    }
    if (set.has(key)) return true;
    set.add(key);
    return false;
  }

  private assistant(c: Ctx): void {
    const m = rec(c.j.message);
    if (!m) return;
    const blocks: unknown[] = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    if (this.fork === 'expect-spawn') {
      const spawn = blocks.map(rec).find((b) => b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task'));
      const id = str(spawn?.id);
      this.fork = id ? 'expect-result' : undefined;
      if (id) {
        this.inheritedSpawn = id;
        return;
      }
    }
    const synthetic = m.model === '<synthetic>';
    if (c.j.isApiErrorMessage === true || (synthetic && str(c.j.error))) {
      const text = blocks.map((b) => rec(b)?.text).filter((t): t is string => typeof t === 'string').join('\n');
      return this.sysContent(c, text || tr('API error'), 'error');
    }
    const msgId = str(m.id) ?? c.uuid;
    blocks.forEach((raw, i) => {
      const b = rec(raw);
      if (!b) return;
      const id = `${c.uuid}:${i}`;
      switch (b.type) {
        case 'text': {
          const t = typeof b.text === 'string' ? b.text : '';
          if (!t.trim() || this.repeated(msgId, `t${t.length}:${t.slice(0, 64)}`)) return;
          if (synthetic) {
            if (!NO_RESPONSE.test(t.trim())) this.sysContent(c, t, 'info', undefined, `:${i}`);
            return;
          }
          const text = marked(prepare(t, TEXT_MAX));
          if (text) this.emit({ kind: 'assistant', id, at: c.at, text });
          return;
        }
        case 'thinking':
        case 'redacted_thinking': {
          const t = typeof b.thinking === 'string' ? b.thinking : '';
          const sig = typeof b.signature === 'string' ? b.signature : typeof b.data === 'string' ? b.data : '';
          if (this.repeated(msgId, `k${t.length}:${t.slice(0, 64)}:${sig.length}:${sig.slice(-24)}`)) return;
          const e: ThinkingEntry = { kind: 'thinking', id, at: c.at };
          if (b.type === 'thinking' && t.trim()) {
            const text = marked(prepare(t, THINKING_MAX));
            if (text) e.text = text;
          }
          this.emit(e);
          return;
        }
        case 'tool_use':
        case 'server_tool_use': {
          const name = str(b.name) ?? 'ferramenta';
          const view = toolView(name, rec(b.input) ?? {}, c.cwd);
          const e: ToolEntry = { kind: 'tool', id: str(b.id) ?? id, at: c.at, tool: name, title: maskSecrets(view.title) };
          if (view.input) {
            e.input = view.input;
            e.inputKind = view.inputKind;
          }
          this.emit(e);
          return;
        }
        default:
          return;
      }
    });
  }

  // ---------------------------------------------------------------- system and attachment

  private system(c: Ctx): void {
    const j = c.j;
    const content = typeof j.content === 'string' ? j.content : '';
    switch (j.subtype) {
      case 'compact_boundary': {
        const trigger = rec(j.compactMetadata)?.trigger;
        return this.sys(c, trigger === 'manual' ? tr('Conversation compacted (/compact)') : trigger === 'auto' ? tr('Conversation compacted automatically') : tr('Conversation compacted'));
      }
      case 'api_error': {
        // One line per attempt: only the first of each sequence becomes an entry.
        const attempt = typeof j.retryAttempt === 'number' ? j.retryAttempt : undefined;
        if (attempt !== undefined && attempt > 1) return;
        const err = rec(j.error);
        const why = str(err?.formatted) ?? str(err?.message) ?? str(j.error);
        const max = typeof j.maxRetries === 'number' ? j.maxRetries : undefined;
        const retry = attempt !== undefined ? tr(' — retrying{0}', [max ? tr(' (up to {0} times)', [max]) : '']) : '';
        return this.sys(c, tr('API error{0}{1}', [why ? `: ${oneLine(why, 140)}` : '', retry]), { level: 'error' });
      }
      case 'local_command':
        return this.userText(c, content);
      case 'turn_duration':
        if (typeof j.durationMs === 'number' && j.durationMs >= 0) this.sys(c, tr('Turn completed in {0}', [formatDuration(j.durationMs)]));
        return;
      case 'informational':
        return this.sysContent(c, content, j.level === 'warning' ? 'warn' : j.level === 'error' ? 'error' : 'info');
      case 'model_refusal_fallback':
        return this.sysContent(c, content, 'warn');
      case 'away_summary':
        return this.sysContent(c, content, 'info', tr('Recap'));
      default:
        // stop_hook_summary, bridge_status (brings remote session link)... only errors pass.
        if (j.level === 'error') this.sysContent(c, content, 'error');
        return;
    }
  }

  private attachment(c: Ctx): void {
    const a = rec(c.j.attachment);
    // Only queued commands are relevant; those from other agents (peer/coordinator) are meta.
    if (!a || a.type !== 'queued_command' || a.isMeta === true || c.j.isMeta === true) return;
    let text = '';
    let images = 0;
    if (typeof a.prompt === 'string') text = a.prompt;
    else if (Array.isArray(a.prompt)) {
      const texts: string[] = [];
      for (const raw of a.prompt) {
        const b = rec(raw);
        if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b?.type === 'image') images++;
      }
      text = texts.join('\n');
    }
    if (text.trimStart().startsWith('<task-notification>')) return this.notification(c, text.trim());
    if (a.commandMode !== undefined && a.commandMode !== 'prompt') return;
    this.userText(c, text, images);
  }
}

/** Stateful parser: one instance per file read, fed line by line in file order. */
export function createTerminalParser(): TerminalParser {
  return new Parser();
}
