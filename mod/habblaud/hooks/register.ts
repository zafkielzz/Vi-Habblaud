// Habblaud mod (Claude Code 2.1.287+): connects each session to the office without reading the conversation.
//
// Does three small things, and `claude plugin validate` lists exactly what the module calls (the output
// is in mod/README.md):
//
// 1. Plan usage (replaces statusline tap): on `session.start` and every `session.measure`
//    (after each turn and when a limit advances a full point) writes
//    <HABBLAUD_USAGE_DIR or ~/.habblaud/usage>/<account>.json in the SAME format as scripts/statusline-tap.mjs
//    ({accountId, configDir, fetchedAt, five_hour, seven_day}, `resets_at` in seconds) plus
//    `source: "mod"`. The server reads these files in server/accounts/statusline.ts.
// 2. A line below the prompt when ANOTHER session needs you: every 5 s polls local Habblaud
//    (GET /api/mod/summary, which already filters out this session and its subagents). The poll also carries
//    this session's context window (`window`), so "Boss overloaded" measures against the real one. When offline, the
//    line disappears and polling backs off to every 30 s until it returns. Only where the session renders
//    (empty `$.session.surfaces()` = `claude -p`/SDK: nothing to show, nothing to ask).
// 3. /habblaud: office summary, answered by the mod itself (does not call the model, does not consume usage).
// 4. Office rules, only while this session is the boss of an office (agy-hub `rules-hook boss`, run at the session
//    start and on each prompt): the rules for the boss go with the first prompt and again whenever the user changes
//    them (rev), as context the model reads; each Edit/Write/MultiEdit/NotebookEdit/Read/Grep/Glob/Bash call is checked
//    by `rules-hook` (the same script Claude workers run as a PreToolUse hook) and denied with its reason when it is
//    against the rules. No rules-hook installed, an error or a timeout = allowed, as before.
//
// Rules: no hook throws (a hook that throws is skipped, but whatever it left half-done remains): each
// step has its own try/catch and failure = silence. $.process only runs rules-hook; no $.model, $.prompt or
// conversation reading; network is 127.0.0.1 only. State lives in module variables: a
// hot reload restarts from scratch, which here costs at most one extra rewrite of the usage file.
//
// Claude Code static analysis: each call is written out in full ($.noun.method), the event name is
// always a string literal, and `$` is only passed to functions declared at the top of this file.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

/** Standard Habblaud port (the same as the server, permission hook, and docker-compose). */
export const DEFAULT_PORT = 4747
/** Polling interval for Habblaud; when offline, backs off to the second until it returns. */
export const POLL_MS = 5_000
export const OFFLINE_POLL_MS = 30_000
/** How long to wait for local Habblaud to respond (`$.http.fetch` does not accept AbortSignal: race with a timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Identical values written less than this ago are not rewritten (same rule as the tap). */
export const MIN_REWRITE_MS = 10_000
/** Tools whose calls the office rules check (agy-hub bin/rules-hook). */
export const RULES_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'Bash']
/** How long rules-hook may take (it answers in ~20 ms); past that the call is allowed. */
export const RULES_TIMEOUT_MS = 3_000
/** Names on the line below the prompt before "and N more". */
const MAX_NAMES = 3

/** A window in tap format: 0–100 percentage and reset in SECONDS since epoch. */
export interface UsageWindow {
  utilization: number
  resets_at?: number
}

/** The usage record: tap format plus `source`, to know who wrote it. */
export interface UsageRecord {
  accountId: string
  configDir: string
  fetchedAt: number
  five_hour?: UsageWindow
  seven_day?: UsageWindow
  source: 'mod'
}

/** Who needs you, as returned by GET /api/mod/summary (without demo and without this session). */
export interface WaitingAgent {
  id: string
  name: string
  room: string
  account: string
  waitingFor: string
  since?: number
  /** Has a permission request answerable through the office. */
  answerable: boolean
}

export interface Summary {
  version: string
  agents: number
  working: number
  waiting: WaitingAgent[]
}

/** Result of a query to Habblaud: response, offline, or an outdated version without the mod route. */
type Asked = { kind: 'ok'; summary: Summary } | { kind: 'offline' } | { kind: 'outdated' }

/** The office this session is the boss of, from `rules-hook boss`. */
export interface BossRules {
  office: string
  name: string
  rev: number
  /** The rules for the boss, as the model reads them. */
  text: string
}

interface ModEnv {
  /** Account config dir and its id (basename), from tap; missing without HOME/USERPROFILE/CLAUDE_CONFIG_DIR. */
  configDir?: string
  accountId?: string
  /** Usage directory; missing without HOME (or USERPROFILE) or HABBLAUD_USAGE_DIR. */
  usageDir?: string
  port: number
  /** agy-hub bin/rules-hook: HABBLAUD_RULES_HOOK, else ~/.local/bin/rules-hook. */
  rulesHook?: string
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in tests/habblaud.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normalizes a path (repeated slashes, `.`, `..`, and trailing slash): the mod environment lacks node:path.
 * Windows paths (with drive or UNC) come out with `/`, which Windows also accepts, and the drive letter (`C:`)
 * counts as root: that way the server in Docker, which is Linux, can still find the account folder name
 * in the saved configDir. For others, `\` is part of the name (Linux and macOS) and stays as is.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  // Root: the drive, or one of the two UNC slashes (`\\nas\share` becomes `//nas/share`, which needs both).
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

/** `~` at the beginning becomes HOME (as tap does with CLAUDE_CONFIG_DIR and HABBLAUD_USAGE_DIR). */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** Account config dir: the first item of CLAUDE_CONFIG_DIR (with `~` expanded) or ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Account id = folder name (server AccountInfo.id, e.g. ".claude-account2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function usageDirOf(habblaudUsageDir: string | undefined, home: string | undefined): string | undefined {
  const d = (habblaudUsageDir ?? '').trim()
  if (d) return normalizePath(expandHome(d, home))
  return home ? normalizePath(`${home}/.habblaud/usage`) : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/**
 * A window from `$.session.usage().rateLimits` in tap format. `percentUsed` comes as 0 to 100 (exceeds
 * 100 only on a blown spend limit, which we do not record); `resetsAt` comes in ISO 8601 and tap writes SECONDS.
 */
export function windowOf(rl: SessionRateLimit | undefined): UsageWindow | undefined {
  if (!rl || typeof rl.percentUsed !== 'number' || !Number.isFinite(rl.percentUsed)) return undefined
  const w: UsageWindow = { utilization: Math.min(100, Math.max(0, rl.percentUsed)) }
  const ms = typeof rl.resetsAt === 'string' ? Date.parse(rl.resetsAt) : Number.NaN
  if (Number.isFinite(ms)) w.resets_at = Math.round(ms / 1_000)
  return w
}

/**
 * The recorded record, or undefined without a usable window (outside a subscription, or before the first
 * API response, `rateLimits` is empty). Only `five_hour` and `seven_day`: a gateway's `spend_limit`
 * is not a plan limit.
 */
export function usageRecord(rateLimits: readonly SessionRateLimit[], configDir: string, now: number): UsageRecord | undefined {
  const accountId = accountIdOf(configDir)
  if (!accountId) return undefined
  const five = windowOf(rateLimits.find((r) => r.kind === 'five_hour'))
  const week = windowOf(rateLimits.find((r) => r.kind === 'seven_day'))
  if (!five && !week) return undefined
  const rec: UsageRecord = { accountId, configDir, fetchedAt: now, source: 'mod' }
  if (five) rec.five_hour = five
  if (week) rec.seven_day = week
  return rec
}

/** Single-line text (names and rooms come from the server; a newline would break the status line). */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? oneLine(v) : undefined
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

/** Reads the response from GET /api/mod/summary; anything outside the format = undefined (treated as "offline"). */
export function parseSummary(text: string): Summary | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>
  if (!Array.isArray(r.waiting)) return undefined
  const waiting: WaitingAgent[] = []
  for (const item of r.waiting) {
    if (!item || typeof item !== 'object') continue
    const w = item as Record<string, unknown>
    const name = str(w.name)
    if (!name) continue
    const agent: WaitingAgent = {
      id: str(w.id) ?? name,
      name,
      room: str(w.room) ?? '?',
      account: str(w.account) ?? '',
      waitingFor: str(w.waitingFor) ?? 'answer in the terminal',
      answerable: w.answerable === true,
    }
    if (typeof w.since === 'number' && Number.isFinite(w.since)) agent.since = w.since
    waiting.push(agent)
  }
  return { version: str(r.version) ?? '?', agents: count(r.agents), working: count(r.working), waiting }
}

/** The line below the prompt: undefined when no one (other than this session) needs you. */
export function statusText(waiting: readonly WaitingAgent[]): string | undefined {
  const first = waiting[0]
  if (!first) return undefined
  if (waiting.length === 1) return `🏢 ${first.name} needs you in ${first.room}`
  const shown = waiting.slice(0, MAX_NAMES).map((w) => `${w.name} (${w.room})`)
  const rest = waiting.length - shown.length
  return `🏢 ${waiting.length} need you: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
}

/** /habblaud response when Habblaud is online. */
export function summaryText(s: Summary, url: string): string {
  const agents = s.agents === 1 ? '1 agent' : `${s.agents} agents`
  const waiting =
    s.waiting.length === 0
      ? 'no one needs you'
      : s.waiting.length === 1
        ? '1 needs you'
        : `${s.waiting.length} need you`
  const lines = [`Habblaud ${s.version} at ${url}`, `${agents} · ${s.working} working · ${waiting}`]
  for (const w of s.waiting) {
    lines.push(`✋ ${w.name} (${w.room}): ${w.waitingFor}${w.answerable ? ' · can answer from the office' : ''}`)
  }
  return lines.join('\n')
}

export function offlineText(url: string): string {
  return `Habblaud did not respond at ${url}. To start it: npm run docker:up in the Habblaud folder.`
}

export function outdatedText(url: string): string {
  return (
    `Habblaud at ${url} is running a version without the mod route. ` +
    'To update: git pull and npm run docker:up in the Habblaud folder.'
  )
}

/** `rules-hook boss` output: the boss's office and rules, or undefined (not a boss, or anything malformed). */
export function parseBossRules(stdout: string): BossRules | undefined {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    if (!j || typeof j.office !== 'string' || typeof j.text !== 'string' || !j.text.trim()) return undefined
    return { office: j.office, name: typeof j.name === 'string' ? j.name : j.office, rev: typeof j.rev === 'number' ? j.rev : 0, text: j.text }
  } catch {
    return undefined
  }
}

/** The deny reason in rules-hook's PreToolUse output, or undefined (allowed). */
export function parseDeny(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined
  try {
    const o = (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } }).hookSpecificOutput
    if (o?.permissionDecision !== 'deny') return undefined
    return typeof o.permissionDecisionReason === 'string' && o.permissionDecisionReason ? o.permissionDecisionReason : 'Office rule: not allowed here.'
  } catch {
    return undefined
  }
}

/** The event rules-hook reads on stdin for a tool call (the tool's arguments without the engine's own keys). */
export function rulesEvent(e: Record<string, unknown>): string {
  const { tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, consent: _consent, ...input } = e
  return JSON.stringify({ tool_name: tool, tool_input: input })
}

// ---------------------------------------------------------------------------------------------
// Module state (disappears on hot reload) and interaction with Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
/** Last write of the usage file (key = file + values), to avoid rewriting the same within 10 s. */
let lastWrite: { key: string; at: number } | undefined
/** Status line text; null = not yet touched in this load (the first call always goes through). */
let lastStatus: string | undefined | null = null
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** One query at a time: a slow Habblaud does not accumulate queries. */
let polling = false
/** Context window of this session's model (status line `context_window_size`), sent with each poll. */
let contextWindow: number | undefined
/** The office this session is the boss of (undefined: not a boss, the tool calls are not checked). */
let boss: BossRules | undefined
/** office:rev of the rules last given to the model. */
let rulesSent: string | undefined

/** Session environment, read once per load (each name written out in full, as analysis requires). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // On Windows, HOME only exists if defined: USERPROFILE applies (same order as server: HOME then homedir()).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    usageDir: usageDirOf(await $.env.get('HABBLAUD_USAGE_DIR'), home),
  }
  const hook = (await $.env.get('HABBLAUD_RULES_HOOK'))?.trim() || (home ? `${home}/.local/bin/rules-hook` : '')
  if (hook) next.rulesHook = hook
  if (configDir) {
    next.configDir = configDir
    const accountId = accountIdOf(configDir)
    if (accountId) next.accountId = accountId
  }
  env = next
  return next
}

/** Writes usage for this account (if windows exist and changed or interval passed). May throw: caller swallows. */
async function writeUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  if (!rateLimits.length) return
  const e = await readEnv($)
  if (!e.configDir || !e.usageDir) return
  const now = await $.clock.now()
  const rec = usageRecord(rateLimits, e.configDir, now)
  if (!rec) return
  const file = `${e.usageDir}/${rec.accountId}.json`
  const key = JSON.stringify([file, rec.configDir, rec.five_hour, rec.seven_day])
  if (lastWrite && lastWrite.key === key && now - lastWrite.at >= 0 && now - lastWrite.at < MIN_REWRITE_MS) return
  // $.fs.write creates the folder if missing and is NOT atomic: the server reader ignores a
  // half-written read and keeps the last good record (server/accounts/statusline.ts).
  await $.fs.write(file, `${JSON.stringify(rec)}\n`)
  lastWrite = { key, at: now }
}

/** GET /api/mod/summary with 2 s timeout; never throws. */
async function askHabblaud($: EngineInterface, port: number, query: string): Promise<Asked> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(FETCH_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const res = await Promise.race([$.http.fetch(`http://127.0.0.1:${port}/api/mod/summary${query}`, { headers: { accept: 'application/json' } }), timeout])
    if (!res) return { kind: 'offline' }
    // 404 JSON = Habblaud from before the mod (unknown route, in any of its languages); any other 404 = not Habblaud.
    if (res.status === 404 && /rota desconhecida|unknown route|route không xác định/.test(res.text)) return { kind: 'outdated' }
    const summary = res.ok ? parseSummary(res.text) : undefined
    return summary ? { kind: 'ok', summary } : { kind: 'offline' }
  } catch {
    return { kind: 'offline' }
  } finally {
    wait?.cancel()
  }
}

/** Updates status line only when text changes. */
function setStatus($: EngineInterface, text: string | undefined): void {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

/** (Re)schedules polling: 5 s when Habblaud is online, 30 s when offline. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void poll($)
  })
}

/** One round of notification below the prompt. Never throws. */
async function poll($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.length) {
      setStatus($, undefined)
      return
    }
    const e = await readEnv($)
    const params = new URLSearchParams()
    if (e.accountId) params.set('account', e.accountId)
    params.set('session', await $.session.id())
    if (contextWindow) params.set('window', String(contextWindow))
    const asked = await askHabblaud($, e.port, `?${params.toString()}`)
    if (asked.kind !== 'ok') {
      setStatus($, undefined)
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    setStatus($, statusText(asked.summary.waiting))
  } catch {
    // silence: next round retries
  } finally {
    polling = false
  }
}

/** Text for /habblaud: entire office (without filtering this session, so numbers match screen). */
async function habblaudText($: EngineInterface): Promise<string> {
  const e = await readEnv($)
  const url = `http://localhost:${e.port}`
  const asked = await askHabblaud($, e.port, '')
  if (asked.kind === 'outdated') return outdatedText(url)
  if (asked.kind === 'offline') return offlineText(url)
  return summaryText(asked.summary, url)
}

/** Asks rules-hook whether this session is the boss of an office now (the user may appoint or remove it). Never throws. */
async function refreshBoss($: EngineInterface): Promise<void> {
  try {
    const e = await readEnv($)
    if (!e.rulesHook) return
    const r = await $.process.run([e.rulesHook, 'boss'], { timeoutMs: RULES_TIMEOUT_MS })
    boss = r.exitCode === 0 ? parseBossRules(r.stdout) : undefined
  } catch {
    boss = undefined // no rules-hook: no rules
  }
}

/** rules-hook's verdict on one tool call of the boss: the deny reason, or undefined. May throw: caller allows. */
async function checkRules($: EngineInterface, e: Record<string, unknown>): Promise<string | undefined> {
  const env = await readEnv($)
  if (!env.rulesHook) return undefined
  const r = await $.process.run([env.rulesHook], { stdin: rulesEvent(e), timeoutMs: RULES_TIMEOUT_MS })
  return parseDeny(r.stdout)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'habblaud',
        description: 'Habblaud summary: how many agents, who is working, and who needs you',
      })
    } catch {
      // without the command, the rest continues
    }
    try {
      const usage = await $.session.usage()
      contextWindow = usage.context.window
      await writeUsage($, usage.rateLimits)
    } catch {
      // failure writing = silence (Habblaud keeps the last number it had)
    }
    try {
      schedule($, POLL_MS)
    } catch {
      // without notification below the prompt, the rest continues
    }
    await refreshBoss($)
    return next(e)
  })

  // Office rules for a boss: given with the first prompt, and again when the user changes them.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    await refreshBoss($)
    const r = boss
    if (!r || rulesSent === `${r.office}:${r.rev}`) return next(e)
    rulesSent = `${r.office}:${r.rev}`
    return next({ ...e, context: [...(e.context ?? []), `You are the boss of the office "${r.name}" in Habblaud.\n${r.text}`] })
  }).catch(($, e, next) => next(e))

  // A boss's tool call against the office rules is denied with the rule's reason.
  on('tool.call', async ($, e, next) => {
    if (!boss || !RULES_TOOLS.includes(e.tool)) return next(e)
    let reason: string | undefined
    try {
      reason = await checkRules($, e as unknown as Record<string, unknown>)
    } catch {
      reason = undefined // rules-hook failed or took too long: allowed
    }
    return reason ? { deny: reason } : next(e)
  }).catch(($, e, next) => next(e)) // fail open: the rules never stop a session that broke them by accident

  // After each turn and when a limit advances a point. `e` brings the same numbers as
  // `$.session.usage()` at that moment, so there is no need to ask again.
  on('session.measure', async ($, e, next) => {
    contextWindow = e.context?.window ?? contextWindow
    try {
      await writeUsage($, e.rateLimits)
    } catch {
      // failure writing = silence
    }
    return next(e)
  })

  on('command.run', { command: 'habblaud' }, async ($) => {
    try {
      return { text: await habblaudText($) }
    } catch {
      return { text: offlineText(`http://localhost:${env?.port ?? DEFAULT_PORT}`) }
    }
  })
}
