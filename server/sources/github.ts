// GitHub events read from transcripts — without tokens and without network (works in Docker, which only mounts
// transcripts): PR opened or merged, push, CI (failed/passed), and release. Derived from tool
// calls (Bash with gh/git, GitHub MCP) and their results:
// - Claude Code itself records in `toolUseResult.gitOperation` what a Bash did in git/GitHub
//   ({pr: {number, url, action: 'created'|'merged'}, push: {branch}}): preferred source;
// - without this (older versions, CI, release), command output (`gh pr create` prints PR URL,
//   `git push` lines "abc..def  main -> main", `gh run watch` header "✓ main CI · 123"...);
// - background CI: exit code from termination notification, when it belongs to gh itself.
// Only success counts (no celebration for a failed command); when in doubt, no event.
// Pure: the parser (transcript.ts) retains calls and emits 'github' signal.
import { basename, shellWords } from '../../shared/activity';
import type { GitHubEvent } from '../../shared/github';
import { notificationOutcome } from './shells';

/** Git/gh operations that can generate an event. */
type Op = 'push' | 'pr_create' | 'pr_merge' | 'pr_checks' | 'run_watch' | 'run_view' | 'release_create';

/** Call retained until result arrives. */
export interface GitHubCall {
  /** Tool name (Bash or mcp__…). */
  tool: string;
  /** Operations: command operations (Bash) or tool operation (MCP). */
  ops: Op[];
  /** PR from arguments (gh pr merge 12, gh pr checks 12) or MCP. */
  number?: number;
  /** "owner/repo" from -R/--repo or MCP. */
  repo?: string;
  /** Branch from MCP arguments (push_files). */
  branch?: string;
  /** git push --dry-run / --delete: does not push commits. */
  noPush?: boolean;
  /** gh pr merge --auto: only schedules merge. */
  auto?: boolean;
  /** gh release create --draft: draft, does not publish. */
  draft?: boolean;
  /** gh run watch --exit-status: exit code indicates whether CI passed. */
  exitStatus?: boolean;
  /** Command exit code is that of CI gh (last command, no pipe afterwards). */
  ciExit?: boolean;
  /** Launched in background: outcome arrives in termination notification. */
  background?: boolean;
}

// ------------------------------------------------------------------ command

/** A simple script command and the operator that follows it ('' at end). */
interface Segment {
  words: string[];
  next: string;
}

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g;

/** Strips heredoc bodies (commit/PR text is not a command). */
function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let ends: string[] = [];
  for (const line of command.split('\n')) {
    if (ends.length) {
      if (line.trim() === ends[0]) ends = ends.slice(1);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(HEREDOC)) ends.push(m[2]);
  }
  return out.join('\n');
}

/**
 * Splits a shell script into simple commands: splits on `;`, `&&`, `||`, `|`, `&`, newlines, and
 * grouping parentheses, outside quotes and `$(...)`/backticks (which stay intact inside word).
 */
export function scriptSegments(command: string): Segment[] {
  const src = withoutHeredocs(command.slice(0, 20_000));
  const segs: Segment[] = [];
  let start = 0;
  let q: string | null = null;
  let depth = 0;
  const cut = (end: number, next: string) => {
    const text = src.slice(start, end).trim();
    if (text) segs.push({ words: shellWords(text), next });
    else if (segs.length && next) segs[segs.length - 1].next = next;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\' && q !== "'") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      depth++;
      i++;
      continue;
    }
    if (depth) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    let op = '';
    if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) op = c + c;
    else if (c === '|' || c === ';' || c === '\n' || c === '(' || c === ')' || c === '{' || c === '}') op = c;
    else if (c === '&' && src[i - 1] !== '>' && src[i - 1] !== '<' && src[i + 1] !== '>') op = c;
    if (!op) continue;
    cut(i, op === '\n' || op === '(' || op === ')' || op === '{' || op === '}' ? ';' : op);
    i += op.length - 1;
    start = i + 1;
  }
  cut(src.length, '');
  if (segs.length) segs[segs.length - 1].next = '';
  return segs;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'builtin', 'exec', 'env', 'caffeinate', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']);

/** Strips assignments (`X=1`), keywords (`then`, `do`), and prefixes (`timeout 600`, `nohup`). */
function stripWrappers(words: string[]): string[] {
  let i = 0;
  for (let guard = 0; guard < 12 && i < words.length; guard++) {
    const w = words[i];
    if (ASSIGN.test(w) || WRAPPERS.has(w)) i++;
    else if (w === 'timeout' || w === 'gtimeout') {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
      i++; // duration
    } else break;
  }
  return words.slice(i);
}

/** First PR number in arguments: "12", "#12", or PR URL. */
function prNumberIn(args: string[]): number | undefined {
  for (const a of args) {
    const m = /^#?(\d{1,7})$/.exec(a) ?? /\/pull\/(\d{1,7})\b/.exec(a);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Value of a flag (`-R x`, `--repo x`, `--repo=x`). */
function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n && i + 1 < args.length) return args[i + 1];
      if (n.startsWith('--') && args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GH_VALUED = new Set(['-R', '--repo', '--hostname']);

/** Reads a Bash call: which git/gh operations it performs (empty = nothing relevant). */
export function bashCall(command: string): GitHubCall | undefined {
  if (!/\b(?:git|gh)\b/.test(command)) return undefined;
  const call: GitHubCall = { tool: 'Bash', ops: [] };
  const segs = scriptSegments(command);
  segs.forEach((seg, idx) => {
    const words = stripWrappers(seg.words);
    const prog = basename(words[0] ?? '');
    const last = idx === segs.length - 1;
    if (prog === 'git') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += GIT_VALUED.has(words[i]) ? 2 : 1;
      if (words[i] !== 'push') return;
      const args = words.slice(i + 1);
      if (args.some((a) => a === '--dry-run' || a === '-n' || a === '--delete' || a === '-d')) call.noPush = true;
      call.ops.push('push');
    } else if (prog === 'gh') {
      const args = words.slice(1);
      const pos: string[] = [];
      for (let i = 0; i < args.length && pos.length < 2; i++) {
        if (args[i].startsWith('-')) {
          if (GH_VALUED.has(args[i])) i++;
          continue;
        }
        pos.push(args[i]);
      }
      const [noun, verb] = pos;
      const rest = args.slice(args.indexOf(verb ?? '') + 1);
      const repo = flagValue(args, ['-R', '--repo']);
      if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) call.repo = repo;
      const has = (...f: string[]) => rest.some((a) => f.includes(a));
      let op: Op | undefined;
      if (noun === 'pr' && verb === 'create') op = 'pr_create';
      else if (noun === 'pr' && verb === 'merge' && !has('--disable-auto')) {
        op = 'pr_merge';
        if (has('--auto')) call.auto = true;
      } else if (noun === 'pr' && verb === 'checks') op = 'pr_checks';
      else if (noun === 'run' && verb === 'watch') {
        op = 'run_watch';
        if (has('--exit-status')) call.exitStatus = true;
      } else if (noun === 'run' && verb === 'view' && !has('--log', '--log-failed', '--web', '-w')) op = 'run_view';
      else if (noun === 'release' && verb === 'create') {
        op = 'release_create';
        if (has('--draft', '-d')) call.draft = true;
      }
      if (!op) return;
      call.ops.push(op);
      if (op === 'pr_merge' || op === 'pr_checks') call.number ??= prNumberIn(rest);
      // script exit code is that of this gh: last command, nothing chained afterwards
      if ((op === 'pr_checks' || (op === 'run_watch' && call.exitStatus)) && last && !seg.next) call.ciExit = true;
    }
  });
  return call.ops.length ? call : undefined;
}

/** GitHub MCP server (mcp__github__…, mcp__claude_ai_GitHub__…). */
function mcpGitHub(name: string): string | undefined {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  return m && /github/i.test(m[1]) ? m[2] : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,7}$/.test(v)) return Number(v);
  return undefined;
}

/**
 * Stores call if it can generate a GitHub event: Bash with `git push`/`gh pr|run|release`
 * or a GitHub MCP server tool. Undefined = not relevant.
 */
export function githubCallOf(name: string, input: Record<string, unknown>): GitHubCall | undefined {
  if (name === 'Bash') return typeof input.command === 'string' ? bashCall(input.command) : undefined;
  const tool = mcpGitHub(name);
  if (!tool) return undefined;
  const call: GitHubCall = { tool: name, ops: [] };
  const owner = typeof input.owner === 'string' ? input.owner : undefined;
  const repo = typeof input.repo === 'string' ? input.repo : undefined;
  if (owner && repo) call.repo = `${owner}/${repo}`;
  call.number = num(input.pullNumber) ?? num(input.pull_number) ?? num(input.number);
  if (typeof input.branch === 'string') call.branch = input.branch;
  if (/(^|_)create_pull_request$/.test(tool)) call.ops.push('pr_create');
  else if (/(^|_)merge_pull_request$/.test(tool)) call.ops.push('pr_merge');
  else if (/(^|_)push_files$/.test(tool)) call.ops.push('push');
  else if (/workflow_run|check_run|status|actions_get|pull_request_read/.test(tool)) call.ops.push('run_view');
  return call.ops.length ? call : undefined;
}

// ------------------------------------------------------------------ result

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})\b/g;
const RELEASE_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/tag\/([^\s'"<>]+)/;
/**
 * After "To <remote>" line (`git fetch` uses "From"): "   7917867..32a2814  main -> main",
 * " * [new branch]      x -> x" or " + a...b main -> main (forced update)".
 */
const PUSH_TO = /^To \S+/m;
const PUSH_OK = /^\s*[+* ]?\s*(?:[0-9a-f]{4,40}\.{2,3}[0-9a-f]{4,40}|\[new branch\])\s+\S+\s+->\s+(\S+)/m;
const PUSH_FAIL = /\[(?:remote )?rejected\]|failed to push|! \[/;
const PR_EXISTS = /\balready exists\b/i;
const MERGE_FAIL =
  /\b(?:not mergeable|merge conflicts?|failed to|could not|cannot be merged|permission denied|required status checks?|already merged|will be automatically merged|auto-merge)\b|GraphQL:|HTTP [45]\d\d|^\s*X\s/im;
/** Header of `gh run watch`/`gh run view`: "✓ main CI · 123" (X = failed, * = running). */
const RUN_HEADER = /^\s*([✓✔X✗*])\s+(\S+)\s+(.+?)\s+·\s+\d+\s*$/m;
const RUN_DONE = /\bRun (.+?) \(\d+\) completed with '(\w+)'/;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

type CiResult = { result: 'passed' | 'failed'; branch?: string; workflow?: string };
/** CI interpretation: result, 'pending' (still running: nothing to conclude), or undefined (unspecified). */
type CiRead = CiResult | 'pending' | undefined;
const PENDING = /^(pending|queued|in_progress|waiting|requested|expected)$/i;

function conclusion(c: unknown): 'passed' | 'failed' | undefined {
  if (typeof c !== 'string') return undefined;
  const v = c.trim().toLowerCase();
  if (v === 'success') return 'passed';
  return FAILED_CONCLUSIONS.has(v) ? 'failed' : undefined;
}

/** Workflow name without "owner/repo#N" header suffix. */
function workflowName(s: string): string | undefined {
  const w = s.replace(/\s+[\w.-]+\/[\w.-]+#\d+$/, '').trim();
  return w ? w.slice(0, 40) : undefined;
}

/** PR checks (gh pr checks): failed if any failed; passed if all passed and none pending. */
function aggregateChecks(states: Array<{ name?: string; state: string }>): CiRead {
  if (!states.length) return undefined;
  const failed = states.find((s) => /^(fail|failure|error|timed_out|startup_failure)$/i.test(s.state));
  if (failed) return failed.name ? { result: 'failed', workflow: failed.name.slice(0, 40) } : { result: 'failed' };
  if (states.some((s) => PENDING.test(s.state))) return 'pending';
  return states.some((s) => /^(pass|success)$/i.test(s.state)) ? { result: 'passed' } : undefined;
}

/** JSON from `gh run view --json`, `gh pr checks --json`, or CI MCP tools. */
function ciFromJson(j: unknown): CiRead {
  if (Array.isArray(j)) {
    const states = j
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({ name: typeof x.name === 'string' ? x.name : undefined, state: String(x.bucket ?? x.conclusion ?? x.state ?? '') }))
      .filter((s) => s.state);
    return aggregateChecks(states);
  }
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>;
  const branch = typeof o.head_branch === 'string' ? o.head_branch : typeof o.headBranch === 'string' ? o.headBranch : undefined;
  const wf = typeof o.workflowName === 'string' ? o.workflowName : typeof o.name === 'string' ? o.name : undefined;
  const run = conclusion(o.conclusion);
  if (run && (o.status === undefined || o.status === 'completed')) {
    const r: CiResult = { result: run };
    if (branch) r.branch = branch;
    if (wf) r.workflow = wf.slice(0, 40);
    return r;
  }
  if (typeof o.status === 'string' && PENDING.test(o.status)) return 'pending';
  // combined status of a commit/PR: {state, statuses: [...]}
  if (typeof o.state === 'string' && Array.isArray(o.statuses)) {
    if (o.state === 'success') return { result: 'passed' };
    if (o.state === 'failure' || o.state === 'error') return { result: 'failed' };
    return o.state === 'pending' ? 'pending' : undefined;
  }
  if (Array.isArray(o.check_runs)) {
    return ciFromJson((o.check_runs as Array<Record<string, unknown>>).map((c) => ({ name: c?.name, state: c?.status === 'completed' ? c?.conclusion : c?.status })));
  }
  return undefined;
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[') || t.length > 200_000) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** CI result in output of gh run watch/view, gh pr checks, or an MCP tool. */
function ciFromText(text: string, ops: readonly Op[]): CiRead {
  const run = ops.includes('run_watch') || ops.includes('run_view');
  if (run) {
    const h = RUN_HEADER.exec(text);
    if (h?.[1] === '*') return 'pending';
    if (h) {
      const r: CiResult = { result: h[1] === '✓' || h[1] === '✔' ? 'passed' : 'failed', branch: h[2] };
      const wf = workflowName(h[3]);
      if (wf) r.workflow = wf;
      return r;
    }
    const d = RUN_DONE.exec(text);
    const c = d ? conclusion(d[2]) : undefined;
    if (d && c) return { result: c, workflow: d[1].slice(0, 40) };
  }
  // Full JSON (MCP, --json) or a single JSON line (gh ... --json with object --jq)
  const whole = parseJson(text);
  const fromWhole = whole === undefined ? undefined : ciFromJson(whole);
  if (fromWhole) return fromWhole;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (run) {
    for (const l of lines.slice(0, 20)) {
      const j = parseJson(l);
      if (j && !Array.isArray(j)) {
        const r = ciFromJson(j);
        if (r) return r;
      }
    }
    // gh run view --json conclusion --jq .conclusion → "success"
    const c = lines.length ? conclusion(lines[0]) : undefined;
    if (c && ops.includes('run_view')) return { result: c };
  }
  if (ops.includes('pr_checks')) {
    if (/\bAll checks were successful\b/.test(text)) return { result: 'passed' };
    if (/\bSome checks were not successful\b/.test(text) || /\b[1-9]\d* failing\b/.test(text)) return { result: 'failed' };
    if (/\bSome checks are still pending\b/.test(text)) return 'pending';
    // non-TTY output: "name<TAB>pass|fail|pending|skipping<TAB>duration<TAB>url"
    const states = lines
      .map((l) => /^(.+?)\t(pass|fail|pending|skipping|cancel)\t/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1], state: m[2] }));
    return aggregateChecks(states);
  }
  return undefined;
}

/** Exit code of foreground command ("Exit code 1" at start of error result). */
function exitCodeOf(text: string): number | undefined {
  const m = /^Exit code (\d+)/.exec(text.trimStart());
  return m ? Number(m[1]) : undefined;
}

/** CI via exit code of gh itself (gh run watch --exit-status, gh pr checks). */
function ciFromExit(call: GitHubCall, code: number): CiResult | undefined {
  if (!call.ciExit || code >= 128) return undefined; // killed by signal: unknown
  if (call.ops.includes('run_watch')) return { result: code === 0 ? 'passed' : 'failed' };
  // gh pr checks: 1 = some failed, 8 = pending
  if (code === 8) return undefined;
  return { result: code === 0 ? 'passed' : 'failed' };
}

/** CI event: output branch, else checks PR, else transcript branch. */
function ciEvent(call: GitHubCall, ci: CiResult, fallbackBranch?: string): GitHubEvent {
  const ev: GitHubEvent = { kind: ci.result === 'passed' ? 'ci_passed' : 'ci_failed' };
  if (ci.workflow) ev.workflow = ci.workflow;
  if (ci.branch) ev.branch = ci.branch;
  else if (call.number !== undefined && (call.ops.includes('pr_checks') || call.tool !== 'Bash')) ev.number = call.number;
  else if (fallbackBranch) ev.branch = fallbackBranch;
  if (call.repo) ev.repo = call.repo;
  return ev;
}

function gitOperationEvent(call: GitHubCall, tur: Record<string, unknown>): GitHubEvent | undefined {
  const g = tur.gitOperation;
  if (!g || typeof g !== 'object') return undefined;
  const op = g as Record<string, unknown>;
  const pr = op.pr && typeof op.pr === 'object' ? (op.pr as Record<string, unknown>) : undefined;
  if (pr && (pr.action === 'created' || pr.action === 'merged')) {
    const ev: GitHubEvent = { kind: pr.action === 'created' ? 'pr_opened' : 'pr_merged' };
    const n = num(pr.number) ?? call.number;
    if (n !== undefined) ev.number = n;
    const url = typeof pr.url === 'string' ? pr.url : undefined;
    const m = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url) : null;
    if (url && m) {
      ev.url = url;
      ev.repo = m[1];
    } else if (call.repo) ev.repo = call.repo;
    return ev;
  }
  const push = op.push && typeof op.push === 'object' ? (op.push as Record<string, unknown>) : undefined;
  if (push && !call.noPush) {
    const ev: GitHubEvent = { kind: 'push' };
    if (typeof push.branch === 'string' && push.branch) ev.branch = push.branch.replace(/^(?:refs\/heads\/|origin\/)/, '');
    return ev;
  }
  return undefined;
}

/**
 * GitHub event in result of a stored call (undefined = nothing happened, failed, or
 * cannot be confirmed). `branch` = transcript branch, for CI without branch in output.
 */
export function detectGitHubResult(
  call: GitHubCall,
  r: { content: unknown; tur: Record<string, unknown>; isError: boolean; branch?: string },
): GitHubEvent | undefined {
  let text = textOf(r.content);
  if (!text && typeof r.tur.stdout === 'string') text = `${r.tur.stdout}\n${typeof r.tur.stderr === 'string' ? r.tur.stderr : ''}`;
  text = text.slice(0, 200_000);
  const ops = call.ops;
  if (call.tool !== 'Bash') return mcpEvent(call, text, r.isError, r.branch);

  if (!r.isError) {
    const fromOp = gitOperationEvent(call, r.tur);
    if (fromOp) return fromOp;
  }
  if (ops.includes('pr_merge') && !call.auto && !r.isError && !MERGE_FAIL.test(text)) {
    const ev: GitHubEvent = { kind: 'pr_merged' };
    const n = call.number ?? num(/\bpull request (?:[\w.-]+\/[\w.-]+)?#(\d+)/i.exec(text)?.[1]);
    if (n !== undefined) ev.number = n;
    if (call.repo) ev.repo = call.repo;
    return ev;
  }
  if (ops.includes('pr_create') && !r.isError && !PR_EXISTS.test(text)) {
    const urls = [...text.matchAll(PR_URL)];
    const m = urls.at(-1);
    if (m) return { kind: 'pr_opened', number: Number(m[2]), repo: m[1], url: m[0] };
  }
  if (ops.includes('release_create') && !call.draft && !r.isError) {
    const m = RELEASE_URL.exec(text);
    if (m && !m[2].startsWith('untagged-')) return { kind: 'release', tag: safeDecode(m[2]).slice(0, 60), repo: m[1], url: m[0] };
  }
  if (ops.some((o) => o === 'run_watch' || o === 'run_view' || o === 'pr_checks')) {
    // error without "Exit code N" (blocked, declined, interrupted): gh never ran
    const read = ciFromText(text, ops);
    const code = r.isError ? exitCodeOf(text) : 0;
    const ci = read === 'pending' ? undefined : (read ?? (code !== undefined ? ciFromExit(call, code) : undefined));
    if (ci) return ciEvent(call, ci, r.branch);
  }
  if (ops.includes('push') && !call.noPush && !PUSH_FAIL.test(text)) {
    const to = PUSH_TO.exec(text);
    const m = to ? PUSH_OK.exec(text.slice(to.index)) : null;
    if (m) return { kind: 'push', branch: m[1].replace(/^refs\/heads\//, '') };
  }
  return undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Result of a GitHub MCP tool (JSON as text). */
function mcpEvent(call: GitHubCall, text: string, isError: boolean, branch?: string): GitHubEvent | undefined {
  if (isError) return undefined;
  const op = call.ops[0];
  const j = parseJson(text);
  const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  if (op === 'pr_create') {
    const m = [...text.matchAll(PR_URL)][0];
    const n = (m ? Number(m[2]) : undefined) ?? num(o?.number);
    if (n === undefined) return undefined;
    const ev: GitHubEvent = { kind: 'pr_opened', number: n };
    const repo = m?.[1] ?? call.repo;
    if (repo) ev.repo = repo;
    if (m) ev.url = m[0];
    return ev;
  }
  if (op === 'pr_merge') {
    // JSON {"merged": true, ...}; in text, "merged" without failure signal
    const merged = o ? o.merged === true : /\bmerged\b/i.test(text) && !MERGE_FAIL.test(text);
    if (!merged) return undefined;
    const ev: GitHubEvent = { kind: 'pr_merged' };
    if (call.number !== undefined) ev.number = call.number;
    if (call.repo) ev.repo = call.repo;
    return ev;
  }
  if (op === 'push') {
    const ev: GitHubEvent = { kind: 'push' };
    if (call.branch) ev.branch = call.branch;
    return ev;
  }
  if (op === 'run_view' && j !== undefined) {
    const ci = ciFromJson(j);
    if (ci && ci !== 'pending') return ciEvent(call, ci, branch);
  }
  return undefined;
}

/**
 * CI launched in background (gh run watch --exit-status, gh pr checks): outcome is exit
 * code of termination notification — only when it is gh's own exit code (`ciExit`).
 */
export function detectGitHubNotification(call: GitHubCall, status: string | undefined, summary: string | undefined, branch?: string): GitHubEvent | undefined {
  if (!call.ciExit) return undefined;
  const outcome = notificationOutcome('shell', status, summary);
  if (outcome !== 'ok' && outcome !== 'failed') return undefined;
  const exit = summary ? /exit code (-?\d+)/i.exec(summary)?.[1] : undefined;
  const code = exit !== undefined ? Number(exit) : outcome === 'ok' ? 0 : 1;
  const ci = ciFromExit(call, code);
  return ci ? ciEvent(call, ci, branch) : undefined;
}
