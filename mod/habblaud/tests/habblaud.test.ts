// Habblaud mod tests, run by Claude Code itself: `claude plugin test` inside mod/habblaud
// (no session, no login, no network). Stubs respond for Claude Code: env, clock
// (mock.clock), $.session.usage, $.session.id, $.session.surfaces, $.fs.write, $.http.fetch, and $.ui.status.
import type { CommandRunInput, HttpResponse, On, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { accountIdOf, configDirOf, normalizePath, parseBossRules, parseDeny, parseSummary, rulesEvent, statusText, usageDirOf, windowOf, type Summary, type WaitingAgent } from '../hooks/register'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const SEC = (iso: string) => Date.parse(iso) / 1_000
const PORT = '4850'
const SUMMARY_URL = `http://127.0.0.1:${PORT}/api/mod/summary`

const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-06T14:00:00Z' },
  { kind: 'seven_day', percentUsed: 15.5, resetsAt: '2026-10-09T23:00:00.000Z' },
  // spend limit from a gateway: not a plan limit, excluded
  { kind: 'spend_limit', percentUsed: 120 },
]
const CONTEXT = { window: 200_000, tokens: 1_000, percent: 0.5 }

function waiting(name: string, room: string, over: Partial<WaitingAgent> = {}): WaitingAgent {
  return { id: `.claude:${name}`, name, room, account: '.claude', waitingFor: 'approve a permission', answerable: false, ...over }
}

function summary(list: WaitingAgent[], over: Partial<Summary> = {}): Summary {
  return { version: '0.3.0', agents: 7, working: 3, waiting: list, ...over }
}

interface World {
  env?: Record<string, string>
  limits?: SessionRateLimit[]
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Habblaud response: a summary, 'offline' (connection refused), 'hang' (no response) or raw HTTP. */
  answer?: () => Summary | 'offline' | 'hang' | { status: number; text: string }
  /** $.fs.write fails (permission denied, disk full...). */
  writeFails?: boolean
}

/** Registers all stubs (before first call to $, as required) and returns captured items. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/fulano', CLAUDE_CONFIG_DIR: '~/.claude-conta2,/outra/pasta', HABBLAUD_PORT: PORT })
  const writes: Array<{ path: string; text: string }> = []
  const fetches: string[] = []
  const statuses: Array<string | undefined> = []
  const commands: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: w.limits ?? LIMITS } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('fs.write', ($, e) => {
    if (w.writeFails) return { deny: 'EACCES: permission denied' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', async ($, e) => {
    fetches.push(e.url)
    const a = w.answer ? w.answer() : summary([])
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'too late' }
    }
    return { value: 'status' in a ? response(a.status, a.text) : response(200, JSON.stringify(a)) }
  })
  return { clock, writes, fetches, statuses, commands }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
/** /habblaud typed in terminal (kit requires origin and presentation). */
const RUN: CommandRunInput = { command: 'habblaud', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

describe('plan usage', () => {
  test('session.start writes file in tap format, with source "mod"', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.commands).toEqual(['habblaud'])
    expect(w.writes.length).toBe(1)
    // The kit passes the written path with host runner path (on Windows, C:\home\...): strip drive.
    expect(w.writes[0]?.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')).toBe('/home/fulano/.habblaud/usage/.claude-conta2.json')
    expect(w.writes[0]?.text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(w.writes[0]?.text ?? '')).toEqual({
      accountId: '.claude-conta2',
      configDir: '/home/fulano/.claude-conta2',
      fetchedAt: NOW,
      five_hour: { utilization: 42, resets_at: SEC('2026-10-06T14:00:00Z') },
      seven_day: { utilization: 15.5, resets_at: SEC('2026-10-09T23:00:00Z') },
      source: 'mod',
    })
  })

  test('HABBLAUD_USAGE_DIR with ~ and, without CLAUDE_CONFIG_DIR, ~/.claude account', async ($, on) => {
    const w = world(on, { env: { HOME: '/home/fulano', HABBLAUD_USAGE_DIR: '~/usage/' } })
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })
    expect(w.writes.map((x) => x.path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''))).toEqual(['/home/fulano/usage/.claude.json'])
    expect(JSON.parse(w.writes[0]?.text ?? '')).toMatchObject({ accountId: '.claude', configDir: '/home/fulano/.claude' })
  })

  test('Windows: without HOME uses USERPROFILE, and CLAUDE_CONFIG_DIR with \\ yields same account', async ($, on) => {
    const w = world(on, { env: { USERPROFILE: 'C:\\Users\\fulano', CLAUDE_CONFIG_DIR: 'C:\\Users\\fulano\\.claude-conta2\\', HABBLAUD_PORT: PORT } })
    await $.session.start(START)
    expect(w.writes.length).toBe(1)
    // The kit passes written path with host runner path: check only the suffix.
    expect(w.writes[0]?.path).toMatch(/fulano[\\/]\.habblaud[\\/]usage[\\/]\.claude-conta2\.json$/)
    expect(JSON.parse(w.writes[0]?.text ?? '')).toMatchObject({ accountId: '.claude-conta2', configDir: 'C:/Users/fulano/.claude-conta2' })
  })

  test('session.measure: does not rewrite identical values within 10 s; rewrites if changed or after that', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start(START)
    expect(w.writes.length).toBe(1)
    await w.clock.advance(5_000)
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })
    expect(w.writes.length).toBe(1)
    const moved: SessionRateLimit[] = [{ ...LIMITS[0]!, percentUsed: 43 }, LIMITS[1]!]
    await $.session.measure({ context: CONTEXT, rateLimits: moved, changed: ['rateLimits'] })
    expect(w.writes.length).toBe(2)
    expect(JSON.parse(w.writes[1]?.text ?? '')).toMatchObject({ fetchedAt: NOW + 5_000, five_hour: { utilization: 43 } })
    await w.clock.advance(10_000)
    await $.session.measure({ context: CONTEXT, rateLimits: moved, changed: ['cost'] })
    expect(w.writes.length).toBe(3)
    expect(JSON.parse(w.writes[2]?.text ?? '')).toMatchObject({ fetchedAt: NOW + 15_000 })
  })

  test('without plan window (outside subscription, only spend_limit) writes nothing', async ($, on) => {
    const w = world(on, { limits: [] })
    await $.session.start(START)
    await $.session.measure({ context: CONTEXT, rateLimits: [{ kind: 'spend_limit', percentUsed: 80 }], changed: ['rateLimits'] })
    expect(w.writes).toEqual([])
  })

  test('write failure = silent: session starts and command is registered', async ($, on) => {
    const w = world(on, { writeFails: true })
    expect(await $.session.start(START)).toEqual({ cwd: '/work' })
    expect(await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })).toEqual({ changed: ['rateLimits'] })
    expect(w.commands).toEqual(['habblaud'])
    expect(w.writes).toEqual([])
  })
})

describe('line below prompt', () => {
  test('the poll carries the context window of session.start, then of the latest session.measure', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.fetches.at(-1)).toBe(`${SUMMARY_URL}?account=.claude-conta2&session=sess-1&window=200000`)
    await $.session.measure({ context: { ...CONTEXT, window: 1_000_000 }, rateLimits: LIMITS, changed: ['context'] })
    await w.clock.advance(5_000)
    expect(w.fetches.at(-1)).toBe(`${SUMMARY_URL}?account=.claude-conta2&session=sess-1&window=1000000`)
  })

  test('nobody, one, multiple people (truncates at 3 names); only calls $.ui.status when text changes', async ($, on) => {
    let list: WaitingAgent[] = []
    const w = world(on, { answer: () => summary(list) })
    await $.session.start(START)
    expect(w.fetches).toEqual([])
    await w.clock.advance(5_000)
    expect(w.fetches).toEqual([`${SUMMARY_URL}?account=.claude-conta2&session=sess-1&window=200000`])
    expect(w.statuses).toEqual([undefined])
    list = [waiting('Valentina', 'loja-virtual')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 Valentina needs you in loja-virtual')
    await w.clock.advance(5_000)
    expect(w.statuses.length).toBe(2)
    list = [waiting('Valentina', 'loja-virtual'), waiting('Elias', 'app-mobile')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 2 need you: Valentina (loja-virtual), Elias (app-mobile)')
    list = [...list, waiting('Bia', 'site'), waiting('Caio', 'api'), waiting('Dora', 'docs')]
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBe('🏢 5 need you: Valentina (loja-virtual), Elias (app-mobile), Bia (site) and 2 more')
    list = []
    await w.clock.advance(5_000)
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.statuses.length).toBe(5)
  })

  test('Habblaud offline: clears line and backs off to 30 s until recovered', async ($, on) => {
    let up = false
    const w = world(on, { answer: () => (up ? summary([waiting('Valentina', 'loja-virtual')]) : 'offline') })
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(1)
    expect(w.statuses).toEqual([undefined])
    await w.clock.advance(25_000)
    expect(w.fetches.length).toBe(1)
    up = true
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(2)
    expect(w.statuses.at(-1)).toBe('🏢 Valentina needs you in loja-virtual')
    await w.clock.advance(5_000)
    expect(w.fetches.length).toBe(3)
  })

  test('Habblaud hung: gives up after 2 s and clears line', async ($, on) => {
    let hang = false
    const w = world(on, { answer: () => (hang ? 'hang' : summary([waiting('Valentina', 'loja-virtual')])) })
    await $.session.start(START)
    await w.clock.advance(5_000)
    expect(w.statuses).toEqual(['🏢 Valentina needs you in loja-virtual'])
    hang = true
    await w.clock.advance(5_000)
    expect(w.statuses.length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.statuses).toEqual(['🏢 Valentina needs you in loja-virtual', undefined])
  })

  test('session without surface (claude -p, SDK): does not query Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(15_000)
    expect(w.fetches).toEqual([])
    expect(w.statuses).toEqual([undefined])
  })
})

describe('/habblaud', () => {
  test('online: version, address, count, and one line per waiting agent (entire office)', async ($, on) => {
    const w = world(on, {
      answer: () => summary([waiting('Valentina', 'loja-virtual', { answerable: true }), waiting('Elias', 'app-mobile', { waitingFor: 'answer in the terminal' })]),
    })
    const out = await $.command.run(RUN)
    expect(w.fetches).toEqual([SUMMARY_URL])
    expect(out.text).toBe(
      [
        'Habblaud 0.3.0 at http://localhost:4850',
        '7 agents · 3 working · 2 need you',
        '✋ Valentina (loja-virtual): approve a permission · can answer from the office',
        '✋ Elias (app-mobile): answer in the terminal',
      ].join('\n'),
    )
  })

  test('online and nobody waiting', async ($, on) => {
    world(on, { answer: () => summary([], { agents: 1, working: 0 }) })
    const out = await $.command.run(RUN)
    expect(out.text).toBe('Habblaud 0.3.0 at http://localhost:4850\n1 agent · 0 working · no one needs you')
  })

  test('offline: explains how to start', async ($, on) => {
    world(on, { answer: () => 'offline' })
    const out = await $.command.run(RUN)
    expect(out.text).toBe('Habblaud did not respond at http://localhost:4850. To start it: npm run docker:up in the Habblaud folder.')
  })

  test('pre-mod Habblaud (404 "unknown route"): requests update', async ($, on) => {
    world(on, { env: { HOME: '/home/fulano' }, answer: () => ({ status: 404, text: '{"error":"unknown route"}' }) })
    const out = await $.command.run(RUN)
    expect(out.text).toMatch(/^Habblaud at http:\/\/localhost:4747 is running a version without the mod route/)
  })
})

describe('pure functions', () => {
  test('paths, account, and usage directory as tap calculates', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(usageDirOf(undefined, '/home/f')).toBe('/home/f/.habblaud/usage')
    expect(usageDirOf(undefined, undefined)).toBeUndefined()
  })

  test('Windows paths: \\ becomes /, drive counts as root, and ~\\ is also HOME', () => {
    expect(normalizePath('C:\\Users\\f\\.claude-conta2\\')).toBe('C:/Users/f/.claude-conta2')
    expect(normalizePath('C:\\Users\\..\\..\\x')).toBe('C:/x')
    expect(configDirOf('C:\\Users\\f\\.claude-conta2', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(configDirOf('~\\.claude-conta2', 'C:\\Users\\f')).toBe('C:/Users/f/.claude-conta2')
    expect(configDirOf(undefined, 'C:\\Users\\f')).toBe('C:/Users/f/.claude')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(usageDirOf(undefined, 'C:\\Users\\f')).toBe('C:/Users/f/.habblaud/usage')
  })

  test('UNC remains UNC, and outside Windows \\ is part of the name', () => {
    expect(normalizePath('\\\\nas\\share\\uso\\')).toBe('//nas/share/uso')
    expect(usageDirOf('\\\\nas\\share\\uso', undefined)).toBe('//nas/share/uso')
    expect(normalizePath('/home/u/proj\\x')).toBe('/home/u/proj\\x')
    expect(accountIdOf(normalizePath('/home/u/conta\\2'))).toBe('conta\\2')
  })

  test('window: percentage bounded 0–100, reset in seconds; invalid date excluded', () => {
    expect(windowOf({ kind: 'five_hour', percentUsed: 101.5, resetsAt: '2026-10-06T14:00:00.400Z' })).toEqual({ utilization: 100, resets_at: SEC('2026-10-06T14:00:00Z') })
    expect(windowOf({ kind: 'five_hour', percentUsed: 7, resetsAt: 'tomorrow' })).toEqual({ utilization: 7 })
    expect(windowOf({ kind: 'five_hour', percentUsed: Number.NaN })).toBeUndefined()
  })

  test('summary: invalid format = offline; text flattened to single line', () => {
    expect(parseSummary('<html>')).toBeUndefined()
    expect(parseSummary('{"version":"1"}')).toBeUndefined()
    const s = parseSummary(JSON.stringify({ version: '0.3.0', agents: 2, working: 1, waiting: [{ name: 'Ana\nB', room: 'r', answerable: 'sim' }, { room: 'unnamed' }] }))
    expect(s?.waiting).toEqual([{ id: 'Ana B', name: 'Ana B', room: 'r', account: '', waitingFor: 'answer in the terminal', answerable: false }])
    expect(statusText([])).toBeUndefined()
  })
})

describe('office rules (boss)', () => {
  const HOOK = '/hub/rules-hook'
  const ENV = { HOME: '/home/fulano', HABBLAUD_PORT: PORT, HABBLAUD_RULES_HOOK: HOOK }
  const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Office rule (Shop): outside.' } })

  /** rules-hook stand-in: `boss` answers `bossAnswer()`; a tool call is denied when its stdin names /outside. */
  function rulesHook(on: On, bossAnswer: () => object) {
    const runs: Array<{ argv: readonly string[]; stdin?: string }> = []
    on('process.run', ($, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin })
      const stdout = e.argv[1] === 'boss' ? JSON.stringify(bossAnswer()) : e.init?.stdin?.includes('/outside') ? DENY : ''
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const contexts: Array<readonly string[]> = []
    on('prompt.submit', ($, e) => {
      contexts.push(e.context ?? [])
      return { text: e.text, context: e.context }
    })
    const calls: string[] = []
    on('tool.call', ($, e) => {
      calls.push(e.tool)
      return { result: {} }
    })
    return { runs, contexts, calls }
  }

  test('a boss gets its rules with the first prompt and after the user changes them; its tool calls are checked', async ($, on) => {
    world(on, { env: ENV })
    let rev = 1
    const h = rulesHook(on, () => ({ office: 'o1', name: 'Shop', rev, text: 'Office rules of "Shop" (set by the user; they win over the task):' }))
    await $.session.start(START)
    await $.prompt.submit({ text: 'hi' })
    expect(h.contexts[0]?.join('\n')).toContain('You are the boss of the office "Shop" in Habblaud.\nOffice rules of "Shop"')
    await $.prompt.submit({ text: 'again' })
    expect(h.contexts[1]).toEqual([])
    rev = 2
    await $.prompt.submit({ text: 'after an edit' })
    expect(h.contexts[2]?.join('')).toContain('Office rules of "Shop"')

    const denied = await $.tool.call({ tool: 'Edit', file_path: '/outside/a.py', old_string: 'a', new_string: 'b' })
    expect(JSON.stringify(denied)).toContain('Office rule (Shop): outside.')
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'x' })
    expect(h.calls).toEqual(['Bash', 'WebFetch'])
    const checked = h.runs.filter((r) => r.argv.length === 1)
    expect(checked.map((r) => JSON.parse(r.stdin ?? '{}').tool_name)).toEqual(['Edit', 'Bash'])
    expect(checked[0]?.argv).toEqual([HOOK])
  })

  test('not a boss (or no rules-hook): no rules, tool calls go straight on', async ($, on) => {
    world(on, { env: ENV })
    const h = rulesHook(on, () => ({}))
    await $.session.start(START)
    await $.prompt.submit({ text: 'hi' })
    await $.tool.call({ tool: 'Edit', file_path: '/outside/a.py', old_string: 'a', new_string: 'b' })
    expect(h.contexts).toEqual([[]])
    expect(h.calls).toEqual(['Edit'])
    expect(h.runs.every((r) => r.argv[1] === 'boss')).toBe(true)
  })

  test('parsing rules-hook output', () => {
    expect(parseBossRules('{}')).toBeUndefined()
    expect(parseBossRules('nope')).toBeUndefined()
    expect(parseBossRules('{"office":"o1","rev":3,"text":"R"}')).toEqual({ office: 'o1', name: 'o1', rev: 3, text: 'R' })
    expect(parseDeny('')).toBeUndefined()
    expect(parseDeny(DENY)).toBe('Office rule (Shop): outside.')
    expect(parseDeny('{"hookSpecificOutput":{"permissionDecision":"allow"}}')).toBeUndefined()
    expect(JSON.parse(rulesEvent({ tool: 'Bash', tool_use_id: 't1', agentId: 'a', command: 'ls' }))).toEqual({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  })
})
