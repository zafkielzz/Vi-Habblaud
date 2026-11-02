#!/usr/bin/env node
// Habblaud hook for OpenAI Codex (the `codex` CLI and desktop app, which write to the same CODEX_HOME): shows in
// the office what Codex sessions are doing and lets you approve or deny approval requests (PermissionRequest)
// from the office. `npm run codex:install` adds to <CODEX_HOME>/hooks.json, at the END of each event list,
// a group that runs:
//
//   node "/path/to/habblaud/mod/habblaud-codex/hook.mjs"
//
// The command never takes flags: Codex stores trust for each hook (approved by you in /hooks) in a hash that
// includes the command string. Port and timeout live in ~/.habblaud/codex-hook.json ({port, permissionTimeoutS},
// written by the installer); HABBLAUD_PORT acts as fallback (the hook environment comes from the process that
// launched the Codex daemon, so variables exported in your shell might not reach here).
//
// The hook:
// 1. reads event JSON from stdin (session_id, hook_event_name, cwd, transcript_path...);
// 2. sends the event with trimmed text to POST http://127.0.0.1:<port>/api/codex/events (short deadline), with
//    the account (basename of CODEX_HOME, as calculated by the server) and CODEX_HOME path;
// 3. on PermissionRequest only: registers the request via POST /api/permissions (provider "codex") and waits for
//    a decision via GET /api/permissions/:id/wait up to the configured timeout (default 25 s, between 5 and 120).
//    Approved: prints allow decision; denied: deny with reason. Anything else ("answer in the terminal", timeout,
//    Habblaud offline, or no open page): exits without printing anything, and Codex proceeds with normal approval.
//    Note: Codex only shows terminal approval AFTER the hook finishes (meanwhile terminal shows hook statusMessage).
//
// Rules: Pure Node (22+), only `node:*`, no dependencies; never hangs or breaks the session: any error = exit 0
// with no output (never 2, which in Codex denies the request). Never prints updatedInput, updatedPermissions, or
// interrupt (Codex rejects them: the hook "fails" undecided). For observation events, nothing goes to stdout
// (in UserPromptSubmit and SessionStart it would become model context). Speaks only with 127.0.0.1.
// HABBLAUD_HOOK_DEBUG=1 logs details to stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
/** Default wait for a decision in the office (seconds). */
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Configuration file in ~/.habblaud (written by the installer). */
export const CONFIG_FILE = 'codex-hook.json';
/** Events sent to Habblaud (PermissionRequest too, before registering the request). */
export const OBSERVED = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PermissionRequest']);
/** Event send timeout: Habblaud responds immediately (and the hook cannot delay Codex). */
const EVENT_TIMEOUT_MS = 1_500;
/** SessionEnd has only 1 s in Codex (and always runs in the foreground). */
const SESSION_END_TIMEOUT_MS = 600;
/** Register request: if Habblaud does not respond in this time, it is offline (or stuck). */
const REGISTER_TIMEOUT_MS = 2_000;
/** Maximum wait for each long-poll (server replies "pending" and hook polls again). */
const POLL_S = 25;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Event and argument strings sent to Habblaud (the server only displays previews). */
const MAX_STRING = 8_000;
/** Request body (server rejects above 256 KB). */
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-codex] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Absolute path, with `~`/`$HOME` expanded and no trailing slash (how the server normalizes account directories). */
function expandHome(p, home) {
  const abs = resolve(p.trim().replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home));
  return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

/**
 * Port and wait: ~/.habblaud/codex-hook.json ({port, permissionTimeoutS}); if missing in file, HABBLAUD_PORT;
 * otherwise defaults. Missing or unreadable file = defaults.
 */
export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const wait = Number(f.permissionTimeoutS);
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    waitMs: (Number.isFinite(wait) && wait > 0 ? Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, wait)) : DEFAULT_WAIT_S) * 1_000,
  };
}

/**
 * Session CODEX_HOME: env var if present; else directory above sessions/YYYY/MM/DD/ (or archived_sessions/)
 * in transcript_path; otherwise ~/.codex.
 */
export function codexHomeOf(env, input) {
  const home = env.HOME || homedir();
  const fromEnv = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (fromEnv) return expandHome(fromEnv, home);
  const t = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
  const m = /^(.+)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+$/.exec(t) ?? /^(.+)[\\/]archived_sessions[\\/][^\\/]+$/.exec(t);
  if (m && isAbsolute(m[1])) return expandHome(m[1], home);
  return join(home, '.codex');
}

/** Account id = basename of CODEX_HOME (how the server ids accounts; collisions resolved by path). */
export function accountOf(codexHome) {
  return basename(codexHome) || codexHome;
}

/** Trims long text (command output, huge patch...). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/** Value with trimmed text; if still too large for body, trims shorter. */
function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/** Body of POST /api/codex/events: entire hook stdin, with text trimmed. */
export function eventBody(input, account, codexHome) {
  const body = { account, codexHome, event: input };
  body.event = fitted(input, (event) => JSON.stringify({ ...body, event }).length);
  return body;
}

/** Body of POST /api/permissions: only what Habblaud uses (no transcript_path). */
export function permissionBody(input, account, codexHome, timeoutMs) {
  const body = { provider: 'codex', account, codexHome, session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd', 'turn_id']) if (typeof input[k] === 'string') body[k] = input[k];
  body.tool_input = fitted(isObject(input.tool_input) ? input.tool_input : {}, (toolInput) => JSON.stringify({ ...body, tool_input: toolInput }).length);
  return body;
}

/** Hook output for a Habblaud decision (undefined = exit undecided). Only allow and deny (+ message). */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const message = reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.';
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
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

/** Sends the event and, on PermissionRequest, decides the request (or not). Returns output to print or undefined. Never throws. */
export async function run(env = process.env, stdinText) {
  const startedAt = Date.now();
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isObject(input) || typeof input.hook_event_name !== 'string' || typeof input.session_id !== 'string' || !input.session_id) return undefined;
    const event = input.hook_event_name;
    if (!OBSERVED.has(event)) return undefined;

    const cfg = readConfig(env);
    const codexHome = codexHomeOf(env, input);
    const account = accountOf(codexHome);
    const base = `http://127.0.0.1:${cfg.port}`;
    const sent = await call(base, 'POST', '/api/codex/events', eventBody(input, account, codexHome), event === 'SessionEnd' ? SESSION_END_TIMEOUT_MS : EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `${sent.status} ${JSON.stringify(sent.json ?? null)}` : 'Habblaud offline'}`);
    if (event !== 'PermissionRequest' || typeof input.tool_name !== 'string' || !input.tool_name) return undefined;
    // No response even to event: Habblaud is offline (or stuck); approval continues in terminal.
    if (!sent) return undefined;

    // Wait time counts from hook start (Codex only shows terminal approval when it terminates).
    const deadline = startedAt + cfg.waitMs;
    const reg = await call(base, 'POST', '/api/permissions', permissionBody(input, account, codexHome, Math.max(0, deadline - Date.now())), REGISTER_TIMEOUT_MS);
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
      const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      if (r.json?.status === 'pending') continue;
      debug(`response: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json);
    }
  } catch (err) {
    debug(`error: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const { waitMs } = readConfig();
  // Safety net: nothing keeps the process alive past timeout (Codex also has hook timeout).
  setTimeout(() => process.exit(0), waitMs + 15_000).unref();
  const out = await run();
  // No process.exit() right after fetch: on Windows (Node 23 to 24.19) it crashes with 0xC0000409 while V8
  // still compiles fetch parser in the background (nodejs/node#56645). Process exits on its own once loop
  // empties, waiting for decision pipe write; if anything holds the loop, process.exit fires 1 s later.
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
