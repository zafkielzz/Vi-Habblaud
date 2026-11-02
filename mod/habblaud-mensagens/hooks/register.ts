// Messages from the office (Claude Code 2.1.287+): brings what you type in Habblaud (in the agent panel
// or key T terminal) into the session, as if you typed it in the terminal.
//
// What it does, and `claude plugin validate` lists exactly what the module calls (output in mod/README.md):
//
// 1. Every 2 s, only where the session renders (`$.session.surfaces()` empty = `claude -p`/SDK: nothing to do)
//    or in a desktop app session (CLAUDE_CODE_ENTRYPOINT=claude-desktop: SDK underneath, without offscreen surfaces),
//    asks local Habblaud if there are messages for it: POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox
//    with {session, account}. The request also marks session presence: that lights up the agent's message box
//    in the office. Offline, or returning anything non-2xx (403 = messages disabled in Habblaud; 404 = version
//    without route), backs off to polling every 30 s until it recovers.
// 2. Each message, in order, goes to the session via `$.prompt.submit({ text, asUser: true })`: the model reads it
//    as yours, without "The habblaud-mensagens plugin sent a message" (session log still names the plugin). Text
//    goes exactly as received. `{drop}` (a hook rejected) or exception = failure, with reason.
//    With the session mid-turn, Claude Code holds prompt until idle and the call may take a while to return:
//    wait per message is at most 2 s. Past that, message is queued in session and counts as delivered, and following
//    messages in the same round go immediately in order without waiting. Thus a round never exceeds a few seconds:
//    server presence (10 s) and confirmation (30 s) do not expire due to a busy session. Tradeoff: a hook
//    rejecting after those 2 s won't reach the office.
//    A message may instead carry `command` {name, args}: model, effort or plan only (COMMANDS), set from the office's
//    agent drawer; any other name is refused here, so the office can never run an arbitrary command in the session.
//    `plan` runs via `$.command.run`, as if you typed `/plan`. `model` and `effort` do NOT run `/model` / `/effort`
//    (Claude Code saves those as the default for new sessions): they are kept in this module and a `turn.step` hook
//    puts them on each request of the main loop, so only this session changes ("default" = back to its own). The
//    transcript records what each answer used, which is what the office shows; the terminal's status line keeps the
//    session's own model. Like the rest of the module state, they reset on a hot reload.
// 3. A single POST /api/mod/inbox/ack with {session, results: [{id, ok, error?}]}. No messages, no ack.
//
// Why a separate plugin from `habblaud` mod: that one only observes (plan usage, notice under prompt,
// /habblaud) and never changes what the session does. This one acts: types in the session on your behalf.
// Kept separate so you can opt out (npm run mod:install -- --sem-mensagens) and static analysis stays short.
//
// Rules: no hook throws (a throwing hook is skipped, but partial state remains): each step has its try/catch
// and failure = silence. One round at a time (a slow Habblaud doesn't pile up requests). No $.process, $.model,
// $.fs, conversation reading, or tool decisions; network is strictly 127.0.0.1. State lives in module variables:
// a hot reload starts fresh (fetched unconfirmed message fails on server in 30 s).
// Claude Code may load plugin from its own copy: path helpers are copies from mod/habblaud/hooks/register.ts,
// not imports.
//
// Claude Code static analysis: each call written in full ($.noun.method), event name is always a string literal,
// and `$` is only passed to functions declared at the top of this file.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Default Habblaud port (same as server, mod, and docker-compose). */
export const DEFAULT_PORT = 4747
/** Polling interval to Habblaud; when offline, backs off to the second value until it recovers. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** How long to wait for local Habblaud to respond (`$.http.fetch` lacks AbortSignal: race with a timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** How long to wait for `$.prompt.submit` before considering message queued in session. */
export const SUBMIT_WAIT_MS = 2_000
/** Maximum failure reason length (from hook or exception; message text is never truncated). */
export const MAX_REASON = 500

/** Slash commands the office may run in the session (model, effort, plan mode); nothing else. */
export const COMMANDS = ['model', 'effort', 'plan'] as const

/** Message as delivered by POST /api/mod/inbox (shared/types.ts, InboxMessage). */
export interface InboxMessage {
  id: string
  /** Text as typed; empty when server sent non-text. */
  text: string
  /** Run this command instead of submitting `text` (one of COMMANDS). */
  command?: { name: (typeof COMMANDS)[number]; args: string }
}

/** Message result, as received by POST /api/mod/inbox/ack. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

/** Outcome of `$.prompt.submit`. */
type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  /** Account id (directory name, as called by server); omitted without HOME (or USERPROFILE) or CLAUDE_CONFIG_DIR. */
  accountId?: string
  port: number
  /** Claude desktop app session (CLAUDE_CODE_ENTRYPOINT=claude-desktop): runs as SDK and only has surfaces
   *  while on screen, but is interactive and receives prompts anyway. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud-mensagens.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes a path (repeated slashes, `.`, `..` and trailing slash): mod environment lacks node:path. Copy
 * from mod/habblaud: Windows paths (with drive or UNC) output `/` and drive counts as root; on others, `\`
 * is part of name.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? (win && slashed.startsWith('//') ? '/' : '')
  const rest = slashed.slice(drive.length)
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push(seg)
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return drive + (abs ? `/${joined}` : joined || (drive ? '' : '.'))
}

/** Leading `~` becomes HOME. */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** Account config dir: first item of CLAUDE_CONFIG_DIR (with `~` expanded) or ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Account id = folder name (server AccountInfo.id, e.g. ".claude-conta2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Body of POST /api/mod/inbox: account only when known. */
export function inboxBody(session: string, account: string | undefined): string {
  return JSON.stringify(account ? { session, account } : { session })
}

/** Body of POST /api/mod/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ session, results })
}

/**
 * Reads POST /api/mod/inbox response; invalid format = undefined (treated as "offline"). Item without id
 * excluded (cannot be acked); with id and without text, enters with empty text to fail immediately rather than
 * server waiting 30 s.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    const msg: InboxMessage = { id: m.id, text: typeof m.text === 'string' ? m.text : '' }
    const c = m.command && typeof m.command === 'object' ? (m.command as Record<string, unknown>) : undefined
    if (c) {
      // An unknown command is not submitted as text either: it fails (empty text).
      const name = COMMANDS.find((x) => x === c.name)
      if (name && (c.args === undefined || typeof c.args === 'string')) msg.command = { name, args: typeof c.args === 'string' ? c.args : '' }
      else msg.text = ''
    }
    out.push(msg)
  }
  return out
}

/** Single-line failure reason with bounded length: `{drop}` text or exception message. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Module state (resets on hot reload) and Claude Code communication
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** One round at a time: a slow Habblaud or busy session won't stack rounds. */
let polling = false
/** Model (alias or id) and effort the office chose for this session's main loop; absent = the session's own. */
const chosen: { model?: string; effort?: Effort } = {}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Session environment, read once per load (each name written in full, as required by analysis). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if defined: USERPROFILE takes precedence (same order as habblaud mod).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  const accountId = configDir ? accountIdOf(configDir) : undefined
  if (accountId) next.accountId = accountId
  env = next
  return next
}

/** What `promise` resolves within `ms`; past that, undefined (promise continues on its own). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** POST JSON to local Habblaud with 2 s deadline: response or undefined (offline, hung). Never throws. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // Without Content-Type, server guard rejects POST (415).
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** A message for the session, as if you typed it. Never throws. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'a session hook rejected the message') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'the session did not accept the message') }
  }
}

/** One of COMMANDS, as if you typed `/name args`. Never throws. */
async function runCommand($: EngineInterface, command: NonNullable<InboxMessage['command']>): Promise<Submitted> {
  try {
    await $.command.run({ command: command.name, args: command.args })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'the session did not run the command') }
  }
}

/** Keeps the office's model or effort for this session (`default` clears it); false for a value it cannot take. */
export function choose(command: NonNullable<InboxMessage['command']>): boolean {
  const v = command.args.trim()
  if (command.name === 'model') {
    if (!/^[\w.[\]-]{1,64}$/.test(v)) return false
    if (v === 'default') delete chosen.model
    else chosen.model = v
    return true
  }
  const effort = EFFORTS.find((x) => x === v)
  if (command.name !== 'effort' || (!effort && v !== 'default')) return false
  if (effort) chosen.effort = effort
  else delete chosen.effort
  return true
}

/** Delivers messages to session in order and returns each outcome. Never throws. */
async function deliver($: EngineInterface, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** A call timed out: session is busy and subsequent messages queue behind it without waiting. */
  let queued = false
  for (const m of messages) {
    if (!m.command && !m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'empty message' })
      continue
    }
    if (m.command && m.command.name !== 'plan') {
      results.push(choose(m.command) ? { id: m.id, ok: true } : { id: m.id, ok: false, error: `unknown ${m.command.name}: ${m.command.args}` })
      continue
    }
    const submitted = m.command ? runCommand($, m.command) : submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)schedules rounds: 2 s with Habblaud online, 30 s offline. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** One round: fetches messages for this session, submits each, and confirms. Never throws. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const res = await postJson($, e.port, '/api/mod/inbox', inboxBody(session, e.accountId))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (!messages.length) return
    const results = await deliver($, messages)
    // Confirmation failed: server marks messages as failed after 30 s ("session did not confirm delivery").
    await postJson($, e.port, '/api/mod/inbox/ack', ackBody(session, results))
  } catch {
    // silence: next round will retry
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // without rounds, session continues normally
    }
    return next(e)
  })
  // The office's model and effort, on each request of this session's main loop (subagents keep theirs).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (!chosen.model && !chosen.effort)) return yield* next(e)
    return yield* next({ ...e, ...(chosen.model ? { model: chosen.model } : {}), ...(chosen.effort ? { effort: chosen.effort } : {}) })
  })
}
