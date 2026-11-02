#!/usr/bin/env node
// Habblaud PermissionRequest hook: lets you approve or deny Claude Code permission requests ("Do you want to…")
// and answer AskUserQuestion prompts from the office. Reaches the session in one of these ways (this file is
// the single source for both):
//
// - `habblaud-permissoes` plugin from repo marketplace (Claude Code 2.1.287+): sibling hooks.json runs
//   `node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"`, with port from HABBLAUD_PORT. Claude Code copies
//   ONLY the plugin folder to the plugin cache: hence no imports outside `node:*` here;
// - `npm run hooks:install` (older versions), which writes to each <account>/settings.json:
//
//   node /path/to/habblaud/mod/habblaud-permissoes/hooks/permission-hook.mjs [--port 4747] [--timeout 300]
//
// Claude Code displays the terminal dialog and runs this hook AT THE SAME TIME (whichever answers first wins);
// for background subagents the dialog only appears after hook finishes. The hook:
// 1. reads request JSON from stdin (session_id, tool_name, tool_input, permission_suggestions...);
// 2. sends to POST http://127.0.0.1:<port>/api/permissions. If Habblaud does not respond, rejects (feature off),
//    says no page is open, or does not recognize session, exits immediately undecided: terminal proceeds normally;
// 3. otherwise, waits for decision via GET /api/permissions/:id/wait (up to 25 s long polls, in a loop) until
//    timeout (default 5 min: --timeout <s> or HABBLAUD_PERMISSION_TIMEOUT);
// 4. approved/denied: prints decision (hookSpecificOutput.decision). Question answered: approves call with ORIGINAL
//    input plus `answers` ({question text: selected labels}, as hook docs specify for AskUserQuestion); page
//    selects by position and texts come from stdin. "Answer in terminal", timeout, or error: exits without
//    printing anything, and terminal answer wins.
//
// Rules: Pure Node (22+), no dependencies; never hangs or breaks session (any error = exit undecided).
// Speaks only to 127.0.0.1. HABBLAUD_HOOK_DEBUG=1 writes details to stderr.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 86_400;
/** Maximum wait for each long-poll (server replies "pending" and hook polls again). */
const WAIT_S = 25;
/** Register request: if Habblaud does not respond in this time, it is offline (or stuck). */
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Argument strings sent to Habblaud (server only displays a preview). */
const MAX_STRING = 8_000;
/** Request body (server rejects above 256 KB). */
const MAX_BODY = 200_000;
/** User question tool: the answer is a selection (`answer` decision), not approve/deny. */
const ASK_TOOL = 'AskUserQuestion';

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-hook] ${msg}\n`) : () => {};

/** Port and timeout: command arguments (--port, --timeout) or env (HABBLAUD_PORT, HABBLAUD_PERMISSION_TIMEOUT). */
export function parseOptions(argv, env = process.env) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(arg('port') ?? env.HABBLAUD_PORT ?? '', 10);
  const timeout = Number(arg('timeout') ?? env.HABBLAUD_PERMISSION_TIMEOUT ?? '');
  return {
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout)) : DEFAULT_TIMEOUT_S) * 1_000,
  };
}

/** Trims long argument texts (e.g. huge Write content). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/**
 * Body sent to Habblaud: only what it uses (no transcript_path or rest of stdin). If still
 * too large (many edits at once), texts are trimmed shorter.
 */
export function requestBody(input, timeoutMs) {
  const body = { session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd']) if (typeof input[k] === 'string') body[k] = input[k];
  if (Array.isArray(input.permission_suggestions)) body.permission_suggestions = input.permission_suggestions;
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimInput(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

/** Non-empty text (responses use stdin strings as received, without trimming). */
const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * AskUserQuestion `answers` ({ORIGINAL question text: ORIGINAL labels of chosen options in order,
 * and free text at the end joined with ", "}) from positional answers returned by Habblaud.
 * undefined = cannot answer (exits undecided and terminal takes precedence): input without `questions`,
 * unanswered question or answered twice, invalid position, non-multiSelect with >1 choice, questions
 * with identical text.
 */
export function answersFor(answers, toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : undefined;
  if (!questions || !Array.isArray(answers) || !answers.length) return undefined;
  const out = {};
  const done = new Set();
  for (const a of answers) {
    const q = a && Number.isInteger(a.question) ? questions[a.question] : undefined;
    if (!q || typeof q !== 'object' || !text(q.question) || done.has(a.question) || Object.hasOwn(out, q.question)) return undefined;
    done.add(a.question);
    const options = Array.isArray(q.options) ? q.options : [];
    const parts = [];
    for (const i of Array.isArray(a.options) ? a.options : []) {
      const label = Number.isInteger(i) && i >= 0 ? options[i]?.label : undefined;
      if (!text(label)) return undefined;
      parts.push(label);
    }
    if (text(a.other)) parts.push(a.other.trim());
    if (!parts.length || (q.multiSelect !== true && parts.length > 1)) return undefined;
    out[q.question] = parts.join(', ');
  }
  // Every real question requires an answer (Habblaud doesn't even show invalid ones).
  if (questions.some((q, i) => q && typeof q === 'object' && text(q.question) && !done.has(i))) return undefined;
  return out;
}

/**
 * Hook output for a Habblaud decision (undefined = exit undecided). An "always allow" rule
 * chosen in the UI returns only as the POSITION: applies original suggestion sent by Claude Code.
 * Question (AskUserQuestion): only `answer` approves (without `answers` the call has no reply); deny is valid.
 */
export function decisionOutput(result, input) {
  if (!result || result.status !== 'decided') return undefined;
  const ask = input?.tool_name === ASK_TOOL;
  if (result.behavior === 'answer') {
    const answers = ask ? answersFor(result.answers, input.tool_input) : undefined;
    if (!answers) return undefined;
    const decision = { behavior: 'allow', updatedInput: { ...input.tool_input, answers } };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'allow') {
    if (ask) return undefined;
    const decision = { behavior: 'allow' };
    const list = Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [];
    const chosen = Number.isInteger(result.suggestion) ? list[result.suggestion] : undefined;
    if (chosen && typeof chosen === 'object') decision.updatedPermissions = [chosen];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const decision = { behavior: 'deny', message: reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.' };
    if (result.interrupt === true) decision.interrupt = true;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Request to local Habblaud; null = offline, timed out, or unreadable response. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'error'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Decides the request (or not). Returns output to print or undefined. Never throws. */
export async function run(argv = process.argv.slice(2), env = process.env, stdinText) {
  try {
    const opts = parseOptions(argv, env);
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return undefined;

    const base = `http://127.0.0.1:${opts.port}`;
    const deadline = Date.now() + opts.timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, opts.timeoutMs), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`no bypass (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud offline'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('timed out: terminal takes precedence');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      const status = r.json?.status;
      if (status === 'pending') continue;
      debug(`response: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json, input);
    }
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Entry point (exported for alias from old path, scripts/permission-hook.mjs). */
export async function main() {
  const { timeoutMs } = parseOptions(process.argv.slice(2));
  // Safety net: nothing keeps the process alive past timeout.
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  // No process.exit() right after fetch: on Windows (Node 23 to 24.19) it crashes with
  // 0xC0000409 while V8 still compiles fetch parser in the background (libuv assert,
  // nodejs/node#56645). Process exits on its own once loop empties, waiting for decision
  // pipe write (async on macOS); if anything holds the loop, process.exit fires 1 s later.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
