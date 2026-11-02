import { describe, expect, it } from 'vitest';
import type { AgentInfo, TaskItem } from './types';
import {
  addDays,
  dayKeyOf,
  dayRange,
  dayStart,
  isValidTimeZone,
  mergeIntervals,
  parseDayFile,
  parseDayKey,
  queryDay,
  StatsBook,
  StatsTracker,
  MAX_GAP_MS,
  MAX_WAITS_PER_DAY,
  MIN_WAIT_MS,
  SETTLE_MS,
  type StatsView,
  type WaitRecord,
} from './daystats';
import { seedDemoHistory } from './demo/daystats';
import { DEMO_PROJECT_NAMES } from './demo/simulator';

const S = 1_000;
const MIN = 60 * S;
const H = 60 * MIN;
/** 2026-10-08 10:00 UTC. */
const T0 = Date.UTC(2026, 9, 8, 10, 0, 0);
const DAY = '2026-10-08';

function agent(p: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    kind: 'main',
    roomId: '/p/loja',
    name: 'Ana',
    look: 'f',
    role: 'Main agent',
    sessionId: `sess-${p.id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0 - 2 * H,
    lastEventAt: T0,
    statusSince: T0 - 5 * MIN,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...p,
  };
}

const ROOMS = [
  { id: '/p/loja', name: 'loja' },
  { id: '/p/api', name: 'api' },
];
const ACCOUNTS = [
  { id: '.claude', name: 'Account C', short: 'C', color: '#f08a3c' },
  { id: '.claude-conta2', name: 'Account D', short: 'D', color: '#4aa8e8' },
];

function view(...agents: AgentInfo[]): StatsView {
  return { agents, rooms: ROOMS, accounts: ACCOUNTS };
}

function setup(tz = 'UTC', startedAt = T0 - H) {
  const book = new StatsBook((t) => dayKeyOf(t, tz));
  const tracker = new StatsTracker(book, { startedAt });
  const day = (key = DAY, qtz = tz, now = T0 + H) => queryDay(book.list(), key, qtz, now);
  return { book, tracker, day };
}

describe('time zones and days', () => {
  it('strictly validates YYYY-MM-DD', () => {
    expect(parseDayKey('2026-10-08')).toEqual({ y: 2026, m: 10, d: 8 });
    expect(parseDayKey('2024-02-29')).not.toBeNull();
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-08', ' 2026-10-08', '2026-10-08 ', '2026/10/08', '20261008', '', '1969-12-31']) {
      expect(parseDayKey(bad), bad).toBeNull();
    }
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('start of day and local time in requested time zone', () => {
    expect(dayStart(DAY, 'UTC')).toBe(Date.UTC(2026, 9, 8));
    // São Paulo (UTC-3, no daylight saving): day starts at 03:00 UTC.
    expect(dayStart(DAY, 'America/Sao_Paulo')).toBe(Date.UTC(2026, 9, 8, 3));
    expect(dayKeyOf(Date.UTC(2026, 9, 8, 2, 59), 'America/Sao_Paulo')).toBe('2026-10-07');
    // 23-hour day (European daylight saving starts 2026-03-29).
    const r = dayRange('2026-03-29', 'Europe/Lisbon');
    expect(r.end - r.start).toBe(23 * H);
  });

  it('accepted time zones', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    for (const bad of ['', 'Marte/Olimpo', '../etc/passwd', 'America/Sao_Paulo; rm', 'a'.repeat(80)]) expect(isValidTimeZone(bad), bad).toBe(false);
  });

  it('merges overlapping intervals', () => {
    expect(
      mergeIntervals([
        [10, 20],
        [15, 30],
        [40, 50],
        [50, 55],
        [60, 60],
      ]),
    ).toEqual([
      [10, 30],
      [40, 55],
    ]);
  });
});

describe('StatsTracker: time per status', () => {
  it('integrates time between samples and splits interval at statusSince', () => {
    const { tracker, day } = setup();
    tracker.observe(view(agent({ id: 'a' })), T0); // first time: reference only
    tracker.observe(view(agent({ id: 'a' })), T0 + 60 * S);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: T0 + 90 * S, waitingFor: 'approve a permission' })), T0 + 120 * S);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: T0 + 90 * S })), T0 + 180 * S);
    tracker.observe(view(agent({ id: 'a', status: 'idle', statusSince: T0 + 200 * S })), T0 + 240 * S);
    tracker.observe(view(agent({ id: 'a', status: 'shell', statusSince: T0 + 250 * S })), T0 + 260 * S);
    const d = day();
    expect(d.totals.ms).toEqual({ working: 90 * S, waiting: 110 * S, idle: 50 * S, shell: 10 * S });
    expect(d.totals.waitWallMs).toBe(110 * S);
    expect(d.totals.waits).toBe(1);
    expect(d.totals.longestWaitMs).toBe(110 * S);
    expect(d.waits[0]).toMatchObject({ agentId: 'a', agentName: 'Ana', roomName: 'loja', start: T0 + 90 * S, end: T0 + 200 * S, reason: 'approve a permission' });
    expect(d.totals.sessions).toBe(1);
    expect(d.hours).toHaveLength(24);
    expect(d.hours[10]).toMatchObject({ hour: 10, ms: { working: 90 * S, waiting: 110 * S } });
    expect(d.rooms.map((r) => r.name)).toEqual(['loja']);
    expect(d.accounts[0]).toMatchObject({ id: '.claude', name: 'Account C', short: 'C', color: '#f08a3c', sessions: 1 });
  });

  it('completed and stopped do not count time; long gap between samples also does not', () => {
    const { tracker, day } = setup();
    tracker.observe(view(agent({ id: 'a' })), T0);
    tracker.observe(view(agent({ id: 'a', status: 'offline', statusSince: T0 + 10 * S })), T0 + 30 * S);
    tracker.observe(view(agent({ id: 'b', status: 'idle' })), T0 + 31 * S);
    tracker.observe(view(agent({ id: 'b', status: 'idle' })), T0 + 31 * S + MAX_GAP_MS + S);
    expect(day().totals.ms).toEqual({ working: 10 * S, waiting: 0, idle: 0, shell: 0 });
  });

  it('wall-clock time with someone waiting does not sum agents', () => {
    const { tracker, day } = setup();
    const v = (st: 'waiting' | 'working') => view(agent({ id: 'a', status: st, statusSince: T0 }), agent({ id: 'b', roomId: '/p/api', account: '.claude-conta2', status: 'waiting', statusSince: T0 }));
    tracker.observe(v('waiting'), T0);
    tracker.observe(v('waiting'), T0 + 60 * S);
    tracker.observe(v('waiting'), T0 + 120 * S);
    const d = day();
    expect(d.totals.ms.waiting).toBe(240 * S);
    expect(d.totals.waitWallMs).toBe(120 * S);
    expect(d.totals.waits).toBe(2);
    // By project: sorted by time waiting for you (tiebreak: higher total time, then name).
    expect(d.rooms.map((r) => [r.name, r.ms.waiting])).toEqual([
      ['api', 120 * S],
      ['loja', 120 * S],
    ]);
    expect(d.accounts.map((a) => a.id).sort()).toEqual(['.claude', '.claude-conta2']);
  });

  it('short waits (blips) do not enter ranking', () => {
    const { tracker, day } = setup();
    tracker.observe(view(agent({ id: 'a' })), T0);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: T0 + 59 * S })), T0 + 60 * S);
    tracker.observe(view(agent({ id: 'a', status: 'working', statusSince: T0 + 60 * S + 500 })), T0 + 61 * S);
    const d = day();
    expect(d.totals.ms.waiting).toBeGreaterThan(0);
    expect(d.totals.ms.waiting).toBeLessThan(MIN_WAIT_MS);
    expect(d.waits).toEqual([]);
    expect(d.totals.waits).toBe(0);
  });

  it('agent disappearing and quickly returning: resumes where left off (same wait, same baseline)', () => {
    const { tracker, day } = setup();
    const stats = (n: number) => ({ toolCalls: n, tokensIn: n * 1000, tokensOut: n * 10, subagents: 0 });
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: T0, stats: stats(10) })), T0);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: T0, stats: stats(10) })), T0 + 30 * S);
    // Disappears from office for a minute...
    tracker.observe(view(), T0 + 31 * S);
    tracker.observe(view(), T0 + 60 * S);
    // ...and returns working, with 5 more tools.
    tracker.observe(view(agent({ id: 'a', status: 'working', statusSince: T0 + 80 * S, stats: stats(15) })), T0 + 90 * S);
    const d = day();
    expect(d.totals.counts.toolCalls).toBe(5);
    expect(d.totals.counts.tokensIn).toBe(5000);
    expect(d.totals.waits).toBe(1);
    expect(d.waits[0].end).toBe(T0 + 80 * S);
    expect(tracker.size).toBe(1);
  });

  it('agent disappearing for longer than max gap: wait closes and interval does not count', () => {
    const { tracker, day } = setup();
    const waiting = agent({ id: 'a', status: 'waiting', statusSince: T0 });
    tracker.observe(view(waiting), T0);
    tracker.observe(view(waiting), T0 + 30 * S);
    tracker.observe(view(), T0 + 31 * S);
    tracker.observe(view(), T0 + 30 * S + MAX_GAP_MS + S);
    tracker.observe(view(waiting), T0 + 30 * S + MAX_GAP_MS + 2 * S);
    tracker.observe(view(waiting), T0 + 30 * S + MAX_GAP_MS + 12 * S);
    const d = day();
    expect(d.totals.ms.waiting).toBe(40 * S);
    expect(d.waits.map((w) => w.ms)).toEqual([30 * S, 10 * S]);
  });

  it('day rollover splits interval at midnight (separate day files)', () => {
    const { book, tracker } = setup();
    const midnight = Date.UTC(2026, 9, 9);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: midnight - 5 * MIN })), midnight - 30 * S);
    tracker.observe(view(agent({ id: 'a', status: 'waiting', statusSince: midnight - 5 * MIN })), midnight + 30 * S);
    expect(book.list().map((d) => d.key).sort()).toEqual(['2026-10-08', '2026-10-09']);
    const d1 = queryDay(book.list(), '2026-10-08', 'UTC', midnight + 30 * S);
    const d2 = queryDay(book.list(), '2026-10-09', 'UTC', midnight + 30 * S);
    expect(d1.totals.ms.waiting).toBe(30 * S);
    expect(d2.totals.ms.waiting).toBe(30 * S);
    expect(d1.hours[23].ms.waiting).toBe(30 * S);
    expect(d2.hours[0].ms.waiting).toBe(30 * S);
    // Wait crosses midnight: appears on both days, with full duration, and remains ongoing.
    expect(d2.waits[0]).toMatchObject({ start: midnight - 30 * S, end: midnight + 30 * S, ms: 60 * S, ongoing: true });
    expect(d1.waits[0].ms).toBe(60 * S);
  });

  it('day is assembled in time zone of caller', () => {
    const { book, tracker } = setup('UTC');
    // 02:00–02:10 UTC = 23:00–23:10 of previous day in São Paulo.
    const t = Date.UTC(2026, 9, 8, 2);
    for (let m = 0; m <= 10; m++) tracker.observe(view(agent({ id: 'a', statusSince: t - MIN })), t + m * MIN);
    const utc = queryDay(book.list(), '2026-10-08', 'UTC', t + H);
    const sp = queryDay(book.list(), '2026-10-07', 'America/Sao_Paulo', t + H);
    expect(utc.totals.ms.working).toBe(10 * MIN);
    expect(utc.hours[2].ms.working).toBe(10 * MIN);
    expect(sp.totals.ms.working).toBe(10 * MIN);
    expect(sp.hours.find((h) => h.ms.working > 0)?.hour).toBe(23);
    expect(queryDay(book.list(), '2026-10-08', 'America/Sao_Paulo', t + H).totals.ms.working).toBe(0);
  });
});

describe('StatsTracker: counts from cumulative numbers', () => {
  it('old agent: baseline, re-read absorbed, deltas afterwards', () => {
    const { tracker, day } = setup('UTC', T0 - H);
    const a = (sec: number, toolCalls: number, tokensIn: number, extra: Partial<AgentInfo> = {}) =>
      tracker.observe(view(agent({ id: 'a', stats: { toolCalls, tokensIn, tokensOut: tokensIn / 100, subagents: 0 }, ...extra })), T0 + sec * S);
    a(0, 100, 1_000_000); // already existed: nothing counts
    a(10, 150, 1_500_000); // start of transcript read in background (within baseline window)
    a(SETTLE_MS / S + 10, 152, 1_550_000); // +2 tools, +50k tokens
    a(SETTLE_MS / S + 11, 20, 200_000); // re-saved file: only trailing window (smaller numbers)
    a(SETTLE_MS / S + 12, 152, 1_550_000); // start read again: returns to what was
    a(SETTLE_MS / S + 13, 155, 1_560_000); // +3, +10k
    a(SETTLE_MS / S + 14, 300, 9_000_000); // impossible jump in 1 s: re-read, not usage
    a(SETTLE_MS / S + 15, 301, 9_001_000); // +1, +1k
    const c = day().totals.counts;
    expect(c.toolCalls).toBe(6);
    expect(c.tokensIn).toBe(61_000);
    expect(c.tokensOut).toBe(610);
  });

  it('cost appearing on old agent becomes baseline; tasks only count increases', () => {
    const { tracker, day } = setup('UTC', T0 - H);
    const tasks = (done: number, total = 3): TaskItem[] => Array.from({ length: total }, (_, i) => ({ id: String(i), title: `t${i}`, status: i < done ? 'completed' : 'pending' }));
    const obs = (sec: number, cost: number | undefined, done: number, total = 3) =>
      tracker.observe(view(agent({ id: 'a', tasks: tasks(done, total), stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, ...(cost === undefined ? {} : { costUSD: cost }) } })), T0 + sec * S);
    obs(0, undefined, 1);
    obs(SETTLE_MS / S + 1, 5, 1); // whole session cost appeared: not today's spend
    obs(SETTLE_MS / S + 2, 5.5, 2); // +0.50 and +1 task
    obs(SETTLE_MS / S + 3, 5.5, 0, 4); // new list (TodoWrite): nothing counts
    obs(SETTLE_MS / S + 4, 5.75, 1, 4); // +0.25 and +1 task
    const c = day().totals.counts;
    expect(c.costUSD).toBe(0.75);
    expect(c.tasksDone).toBe(2);
  });

  it('subagent and session born during observation count from zero', () => {
    const { tracker, day } = setup('UTC', T0 - H);
    tracker.observe(view(agent({ id: 'main' })), T0);
    tracker.observe(
      view(
        agent({ id: 'main' }),
        agent({ id: 'sub', kind: 'sub', parentId: 'main', startedAt: T0 + 5 * S, stats: { toolCalls: 3, tokensIn: 20_000, tokensOut: 300, subagents: 0 } }),
        agent({ id: 'novo', startedAt: T0 + 4 * S }),
      ),
      T0 + 6 * S,
    );
    tracker.observe(view(agent({ id: 'novo', startedAt: T0 + 4 * S, stats: { toolCalls: 2, tokensIn: 9_000, tokensOut: 100, subagents: 0 } })), T0 + 7 * S);
    const d = day();
    expect(d.totals.counts.toolCalls).toBe(5);
    expect(d.totals.counts.tokensIn).toBe(29_000);
    expect(d.totals.subagents).toBe(1);
    expect(d.totals.sessions).toBe(2);
  });

  it('/clear counts from zero; /resume becomes baseline', () => {
    const { tracker, day } = setup('UTC', T0 - H);
    const obs = (sec: number, sessionId: string, toolCalls: number) =>
      tracker.observe(view(agent({ id: 'a', sessionId, stats: { toolCalls, tokensIn: 0, tokensOut: 0, subagents: 0 } })), T0 + sec * S);
    obs(0, 's1', 50);
    obs(SETTLE_MS / S + 1, 's1', 52); // +2
    obs(SETTLE_MS / S + 2, 's2', 0); // /clear: new session, empty
    obs(SETTLE_MS / S + 3, 's2', 4); // +4
    obs(SETTLE_MS / S + 4, 's3', 40); // /resume of an old session: nothing counts
    obs(SETTLE_MS / S + 5, 's3', 41); // within baseline window
    obs(2 * SETTLE_MS / S + 10, 's3', 43); // +2 (since highest seen value)
    const d = day();
    expect(d.totals.counts.toolCalls).toBe(8);
    expect(d.totals.sessions).toBe(3);
  });

  it('prompts: only those after start, each one once', () => {
    const { tracker, day } = setup('UTC', T0);
    const prompt = (id: string, at: number) => ({ id, kind: 'prompt' as const, icon: '📨', text: 'Got a request', at });
    const recent = [prompt('velho', T0 - MIN), prompt('p1', T0 + 2 * S)];
    tracker.observe(view(agent({ id: 'a', recent })), T0 + 3 * S);
    tracker.observe(view(agent({ id: 'a', recent: [...recent, prompt('p2', T0 + 4 * S)] })), T0 + 5 * S);
    tracker.observe(view(agent({ id: 'a', recent: [...recent, prompt('p2', T0 + 4 * S)] })), T0 + 6 * S);
    expect(day().totals.counts.prompts).toBe(2);
  });
});

describe('waits limit per day', () => {
  const wait = (i: number, over: Partial<WaitRecord> = {}): WaitRecord => ({ agentId: `a${i}`, agentName: 'A', roomId: '/p/x', account: 'c', start: T0 + i, end: T0 + i + 1_000 + i, ...over });

  it('closed waits: shortest is dropped and total stays at limit', () => {
    const book = new StatsBook((t) => dayKeyOf(t, 'UTC'));
    const day = book.day(DAY);
    for (let i = 0; i < MAX_WAITS_PER_DAY + 20; i++) book.addWait(wait(i));
    expect(day.waits).toHaveLength(MAX_WAITS_PER_DAY);
    expect(day.waits.some((w) => w.agentId === 'a0')).toBe(false); // shortest dropped
    expect(day.waits.some((w) => w.agentId === `a${MAX_WAITS_PER_DAY + 19}`)).toBe(true); // longest kept
  });

  it('all still open: limit applies same way (shortest is dropped)', () => {
    const book = new StatsBook((t) => dayKeyOf(t, 'UTC'));
    const day = book.day(DAY);
    for (let i = 0; i < MAX_WAITS_PER_DAY + 50; i++) book.addWait(wait(i, { open: true }));
    expect(day.waits).toHaveLength(MAX_WAITS_PER_DAY);
    expect(day.waits.some((w) => w.agentId === 'a0')).toBe(false);
    expect(day.waits.some((w) => w.agentId === `a${MAX_WAITS_PER_DAY + 49}`)).toBe(true);
  });

  it('new open wait that is shortest of all does not enter', () => {
    const book = new StatsBook((t) => dayKeyOf(t, 'UTC'));
    const day = book.day(DAY);
    for (let i = 0; i < MAX_WAITS_PER_DAY; i++) book.addWait(wait(i + 10, { open: true }));
    const tiny = wait(0, { open: true, end: T0 + 1 });
    book.addWait(tiny);
    expect(day.waits).toHaveLength(MAX_WAITS_PER_DAY);
    expect(day.waits).not.toContain(tiny);
  });
});

describe('day file', () => {
  it('JSON roundtrip preserves query', () => {
    const { book, tracker } = setup();
    tracker.observe(view(agent({ id: 'a' }), agent({ id: 'b', status: 'waiting', statusSince: T0, roomId: '/p/api' })), T0);
    tracker.observe(view(agent({ id: 'a' }), agent({ id: 'b', status: 'waiting', statusSince: T0, roomId: '/p/api' })), T0 + MIN);
    const before = queryDay(book.list(), DAY, 'UTC', T0 + H);
    const back = book.list().map((d) => parseDayFile(JSON.parse(JSON.stringify(d.toFile())), d.key)!);
    const after = queryDay(back, DAY, 'UTC', T0 + H);
    // Wait remains open in file (server could have stopped in the middle of it).
    expect({ ...after, waits: after.waits.map((w) => ({ ...w, ongoing: undefined })) }).toEqual({ ...before, waits: before.waits.map((w) => ({ ...w, ongoing: undefined })) });
    expect(back[0].waits[0].open).toBe(true);
  });

  it('malformed file: unknown version is rejected and junk is sanitized', () => {
    expect(parseDayFile(null, DAY)).toBeNull();
    expect(parseDayFile({ version: 2, hours: [] }, DAY)).toBeNull();
    expect(parseDayFile('texto', DAY)).toBeNull();
    const raw = JSON.parse(
      JSON.stringify({
        version: 1,
        hours: [
          { t: T0, ms: { working: -5, waiting: 'x', idle: 1e400, shell: 7 }, counts: { prompts: 2 }, rooms: [['__proto__', { ms: { working: 3 } }], 'lixo'], agents: [['m:s', '/p', '.c'], 5] },
          { t: T0 + 123, ms: { working: 1 } },
        ],
        rooms: [['__proto__', 'x'], [1, 2]],
        accounts: [['.c', { name: 'C', short: 'CCCC', color: 'javascript:alert(1)' }]],
        waits: [{ agentId: 'a', start: T0, end: T0 - 1 }, { agentId: 'b', agentName: 'B', start: T0, end: T0 + 10 * S, open: true }],
      }),
    );
    const d = parseDayFile(raw, DAY)!;
    expect([...d.hours.keys()]).toEqual([T0]);
    expect(d.hours.get(T0)!.ms).toEqual({ working: 0, waiting: 0, idle: 0, shell: 7 });
    expect(d.hours.get(T0)!.rooms.get('__proto__')!.ms.working).toBe(3);
    expect(Object.getPrototypeOf(d.hours.get(T0)!.rooms)).toBe(Map.prototype);
    expect(d.accounts.get('.c')).toEqual({ name: 'C', short: 'CCC', color: '#8b98b3' });
    expect(d.waits.map((w) => w.agentId)).toEqual(['b']);
    expect(() => queryDay([d], DAY, 'UTC', T0)).not.toThrow();
  });
});

describe('fictional demo history', () => {
  it('fills day with demo rooms and accounts deterministically', () => {
    const v: StatsView = {
      agents: [
        agent({ id: 'demo:1', roomId: 'demo:/dev/loja-virtual', account: 'demo:.claude' }),
        agent({ id: 'demo:2', roomId: 'demo:/dev/api-pagamentos', account: 'demo:.claude-conta2', name: 'Bruno' }),
      ],
      rooms: [
        { id: 'demo:/dev/loja-virtual', name: 'loja-virtual' },
        { id: 'demo:/dev/api-pagamentos', name: 'api-pagamentos' },
      ],
      accounts: [
        { id: 'demo:.claude', name: 'Demo X', short: 'X', color: '#5cc97b' },
        { id: 'demo:.claude-conta2', name: 'Demo Y', short: 'Y', color: '#a77bf3' },
      ],
    };
    const now = Date.UTC(2026, 9, 8, 18, 30);
    const book = new StatsBook((t) => dayKeyOf(t, 'UTC'));
    const run = () => {
      const b = new StatsBook((t) => dayKeyOf(t, 'UTC'));
      seedDemoHistory(b, v, now, 'UTC', 42);
      return queryDay(b.list(), DAY, 'UTC', now);
    };
    seedDemoHistory(book, v, now, 'UTC', 42);
    const d = queryDay(book.list(), DAY, 'UTC', now);
    // All of yesterday too (for screenshots taken in the morning).
    expect(queryDay(book.list(), '2026-10-07', 'UTC', now).hours.filter((h) => h.ms.working > 0).length).toBeGreaterThan(12);
    expect(d.totals.ms.working).toBeGreaterThan(H);
    expect(d.totals.ms.waiting).toBeGreaterThan(0);
    expect(d.totals.counts.tokensIn).toBeGreaterThan(0);
    expect(d.totals.counts.costUSD).toBeGreaterThan(0);
    expect(d.waits.length).toBeGreaterThan(0);
    // Open rooms and other demo projects, all with same prefix.
    expect(new Set(d.rooms.map((r) => r.name))).toEqual(new Set(DEMO_PROJECT_NAMES));
    expect(d.rooms.every((r) => r.id.startsWith('demo:/dev/'))).toBe(true);
    expect(d.accounts.every((a) => a.id.startsWith('demo:'))).toBe(true);
    // Nothing after "now", and night inactive.
    expect(d.hours.filter((h) => h.t > now).every((h) => h.ms.working === 0)).toBe(true);
    expect(d.hours[3].ms.working).toBe(0);
    expect(run()).toEqual(d);
  });
});
