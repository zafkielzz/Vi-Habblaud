// Terminal history: listing recent sessions (temporary directories with synthetic JSONLs), ordering,
// 7-day window, limit, mtime cache, open vs. finished, reading only head and tail, and
// resolve() validation of account/id/path.
import { appendFileSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { L, symlinkOrSkip, tempDir, writeLines } from '../test/fixtures';
import { HEAD_BYTES, HISTORY_MAX_AGE_MS, isSessionId, openMainAgent, SessionHistory, TAIL_BYTES, type HistoryAccount } from './history';
import { encodeCwd } from './watcher';

setQuiet(true);

const NOW = Date.UTC(2026, 9, 8, 15, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Conversation line with project cwd (as Claude Code writes). */
const withCwd = (line: string, cwd: string) => JSON.stringify({ ...JSON.parse(line), cwd });

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(): { root: string; acc: (name: string) => HistoryAccount } {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  return { root: tmp.dir, acc: (name) => ({ id: name, dir: join(tmp.dir, name) }) };
}

/** Writes transcript <account>/projects/<encoded cwd>/<sessionId>.jsonl with given mtime. */
function session(acc: HistoryAccount, cwd: string, id: string, lines: string[], mtime: number): string {
  const path = join(acc.dir, 'projects', encodeCwd(cwd), `${id}.jsonl`);
  writeLines(path, lines);
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

function history(accounts: HistoryAccount[], extra: Partial<ConstructorParameters<typeof SessionHistory>[0]> = {}): SessionHistory {
  return new SessionHistory({ accounts: () => accounts, openAgentOf: () => undefined, now: () => NOW, ...extra });
}

describe('SessionHistory.list', () => {
  it('sessions from last 7 days, newest to oldest, with project, title, and timestamps', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const d = acc('.claude-b');
    session(c, '/projetos/loja', sid(1), [withCwd(L.prompt('Fix the cart', { at: NOW - 3 * HOUR }), '/projetos/loja'), L.raw('ai-title', { aiTitle: 'Shopping cart' })], NOW - 3 * HOUR);
    session(d, '/projetos/api', sid(2), [withCwd(L.prompt('Create login route', { at: NOW - 2 * HOUR }), '/projetos/api'), withCwd(L.assistant([L.text('Done.')], { at: NOW - HOUR }), '/projetos/api')], NOW - HOUR);
    // Outside window, non-UUID filename, and subagent transcript: none are included.
    session(c, '/projetos/velho', sid(3), [L.prompt('old', { at: NOW - 8 * 24 * HOUR })], NOW - HISTORY_MAX_AGE_MS - HOUR);
    session(c, '/projetos/loja', 'notes', [L.prompt('x', { at: NOW - HOUR })], NOW - HOUR);
    writeLines(join(c.dir, 'projects', encodeCwd('/projetos/loja'), sid(1), 'subagents', 'agent-a1.jsonl'), [L.prompt('sub', { at: NOW - MIN })]);

    const list = await history([c, d]).list();
    expect(list.map((s) => s.sessionId)).toEqual([sid(2), sid(1)]);
    expect(list[0]).toMatchObject({
      account: '.claude-b',
      project: '/projetos/api',
      projectDir: encodeCwd('/projetos/api'),
      // Without title in transcript: uses first prompt.
      title: 'Create login route',
      firstAt: NOW - 2 * HOUR,
      lastAt: NOW - HOUR,
      open: false,
    });
    expect(list[0].size).toBeGreaterThan(0);
    expect(list[0].agentId).toBeUndefined();
    expect(list[1]).toMatchObject({ account: '.claude', title: 'Shopping cart', project: '/projetos/loja' });
  });

  it('title: custom-title.json from session; no timestamp at end, lastAt = mtime', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const path = session(c, '/p', sid(1), [L.raw('ai-title', { aiTitle: 'Automatic' })], NOW - 2 * HOUR);
    // Line with timestamp at head (otherwise session is ignored) and nothing with timestamp at tail.
    writeFileSync(path, `${L.prompt('hi', { at: NOW - 5 * HOUR })}\n${L.raw('ai-title', { aiTitle: 'Automatic' })}\n`);
    utimesSync(path, (NOW - 2 * HOUR) / 1000, (NOW - 2 * HOUR) / 1000);
    mkdirSync(path.replace(/\.jsonl$/, ''), { recursive: true });
    writeFileSync(join(path.replace(/\.jsonl$/, ''), 'custom-title.json'), JSON.stringify({ customTitle: 'Renamed' }));
    const [s] = await history([c]).list();
    expect(s.title).toBe('Renamed');
    expect(s.lastAt).toBe(NOW - 5 * HOUR);
    expect(s.firstAt).toBe(NOW - 5 * HOUR);
    // Cwd brought by synthetic lines.
    expect(s.project).toBe('/projetos/demo');
  });

  it('limit: only the N most recently modified', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    for (let i = 1; i <= 5; i++) session(c, `/p${i}`, sid(i), [L.prompt(`p${i}`, { at: NOW - i * HOUR })], NOW - i * HOUR);
    const list = await history([c], { limit: 3 }).list();
    expect(list.map((s) => s.title)).toEqual(['p1', 'p2', 'p3']);
  });

  it('mtime cache: unchanged file is not re-read; modified file is', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const a = session(c, '/a', sid(1), [L.prompt('first', { at: NOW - 2 * HOUR })], NOW - 2 * HOUR);
    session(c, '/b', sid(2), [L.prompt('second', { at: NOW - 3 * HOUR })], NOW - 3 * HOUR);
    const h = history([c]);
    await h.list();
    expect(h.reads).toBe(2);
    await h.list();
    expect(h.reads).toBe(2);
    appendFileSync(a, `${L.raw('ai-title', { aiTitle: 'New title' })}\n`);
    utimesSync(a, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
    const list = await h.list();
    expect(h.reads).toBe(3);
    expect(list[0]).toMatchObject({ sessionId: sid(1), title: 'New title' });
  });

  it('open (with office agent) vs. closed; without conversation only included if open', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    session(c, '/a', sid(1), [L.prompt('open', { at: NOW - MIN })], NOW - MIN);
    session(c, '/b', sid(2), [L.prompt('closed', { at: NOW - HOUR })], NOW - HOUR);
    // Only metadata, no timestamp: recently opened session enters; closed without conversation does not.
    session(c, '/c', sid(3), [L.raw('permission-mode', { permissionMode: 'default' })], NOW - 2 * MIN);
    session(c, '/d', sid(4), [L.raw('permission-mode', { permissionMode: 'default' })], NOW - 3 * MIN);
    const open = new Map([[sid(1), '.claude:100'], [sid(3), '.claude:300']]);
    const list = await history([c], { openAgentOf: (account, id) => (account === '.claude' ? open.get(id) : undefined) }).list();
    expect(list.map((s) => [s.sessionId, s.open, s.agentId])).toEqual([
      [sid(1), true, '.claude:100'],
      [sid(3), true, '.claude:300'],
      [sid(2), false, undefined],
    ]);
  });

  it('large file: reads only head and tail (middle title is skipped)', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const filler = (n: number) => Array.from({ length: n }, (_, i) => L.assistant([L.text(`${'x'.repeat(900)} ${i}`)], { at: NOW - 3 * HOUR + i }));
    const lines = [
      withCwd(L.prompt('Head', { at: NOW - 4 * HOUR }), '/projetos/grande'),
      ...filler(200),
      L.raw('custom-title', { customTitle: 'From middle' }),
      ...filler(200),
      L.raw('ai-title', { aiTitle: 'From tail' }),
      L.assistant([L.text('bye')], { at: NOW - HOUR }),
    ];
    session(c, '/projetos/grande', sid(1), lines, NOW - HOUR);
    const [s] = await history([c]).list();
    expect(s.size).toBeGreaterThan(HEAD_BYTES + TAIL_BYTES + 100_000);
    expect(s).toMatchObject({ project: '/projetos/grande', title: 'From tail', firstAt: NOW - 4 * HOUR, lastAt: NOW - HOUR });
  });

  it('title before a huge result at tail: searches larger slice', async () => {
    const { acc } = setup();
    const c = acc('.claude');
    const lines = [
      L.prompt('Head', { at: NOW - 4 * HOUR }),
      ...Array.from({ length: 100 }, (_, i) => L.assistant([L.text(`${'y'.repeat(900)} ${i}`)], { at: NOW - 3 * HOUR + i })),
      L.raw('ai-title', { aiTitle: 'Before result' }),
      L.result('t1', 'z'.repeat(TAIL_BYTES + 10_000), { at: NOW - HOUR }),
    ];
    session(c, '/p', sid(1), lines, NOW - HOUR);
    const [s] = await history([c]).list();
    expect(s.title).toBe('Before result');
  });

  it('account without projects/ or unreadable directory: empty list, no error', async () => {
    const { acc } = setup();
    expect(await history([acc('.claude-nada')]).list()).toEqual([]);
  });
});

describe('SessionHistory.resolve', () => {
  it('known account + UUID id + file inside projects/', () => {
    const { root, acc } = setup();
    const c = acc('.claude');
    const path = session(c, '/projetos/loja', sid(1), [L.prompt('hi')], NOW);
    const h = history([c]);
    const ok = h.resolve('.claude', sid(1));
    expect('path' in ok && ok.path.endsWith(join(encodeCwd('/projetos/loja'), `${sid(1)}.jsonl`))).toBe(true);
    expect(path.endsWith(`${sid(1)}.jsonl`)).toBe(true);

    for (const bad of ['../../etc/passwd', '..', `${sid(1)}/../${sid(1)}`, `${sid(1)}.jsonl`, 'x', '', `${sid(1)} `]) {
      expect(h.resolve('.claude', bad)).toEqual({ status: 400, error: 'invalid session id' });
    }
    for (const account of ['.claude/..', '..', '.claude-outra', '', join(root, '.claude')]) {
      expect(h.resolve(account, sid(1))).toEqual({ status: 404, error: 'unknown account' });
    }
    expect(h.resolve('.claude', sid(9))).toEqual({ status: 404, error: 'session not found' });
  });

  it('link inside projects/ pointing outside is rejected', ({ skip }) => {
    const { root, acc } = setup();
    const c = acc('.claude');
    session(c, '/p', sid(1), [L.prompt('hi')], NOW);
    // Project folder linking outside (junction: on Windows does not require elevation).
    mkdirSync(join(root, 'outra'), { recursive: true });
    writeFileSync(join(root, 'outra', `${sid(3)}.jsonl`), `${L.prompt('secret')}\n`);
    symlinkSync(join(root, 'outra'), join(c.dir, 'projects', 'link'), 'junction');
    const h = history([c]);
    expect(h.resolve('.claude', sid(3))).toEqual({ status: 404, error: 'session not found' });
    expect('path' in h.resolve('.claude', sid(1))).toBe(true);
    // File linking outside is also rejected.
    const outside = join(root, 'fora.jsonl');
    writeFileSync(outside, `${L.prompt('secret')}\n`);
    symlinkOrSkip(skip, outside, join(c.dir, 'projects', encodeCwd('/p'), `${sid(2)}.jsonl`));
    expect(h.resolve('.claude', sid(2))).toEqual({ status: 404, error: 'session not found' });
  });

  it('account without projects/: 404', () => {
    const { acc } = setup();
    expect(history([acc('.claude')]).resolve('.claude', sid(1))).toEqual({ status: 404, error: 'session not found' });
  });
});

describe('utilities', () => {
  it('isSessionId: only UUID format', () => {
    expect(isSessionId(sid(1))).toBe(true);
    expect(isSessionId('7F3C2A10-0B1D-4E2F-9A8B-0123456789AB')).toBe(true);
    for (const v of ['', 'abc', `${sid(1)}x`, `../${sid(1)}`, sid(1).replace(/-/g, '')]) expect(isSessionId(v)).toBe(false);
  });

  it('openMainAgent: main agent for account and session, still in office', () => {
    const a = (p: Partial<AgentInfo>) => ({ id: 'x', kind: 'main', account: '.claude', sessionId: 's1', status: 'idle', ...p }) as AgentInfo;
    const agents = [a({ id: '.claude:1' }), a({ id: 's1:sub', kind: 'sub' }), a({ id: '.claude:2', sessionId: 's2', status: 'offline' }), a({ id: '.b:3', account: '.b', sessionId: 's3' })];
    expect(openMainAgent(agents, '.claude', 's1')).toBe('.claude:1');
    expect(openMainAgent(agents, '.claude', 's2')).toBeUndefined();
    expect(openMainAgent(agents, '.claude', 's3')).toBeUndefined();
    expect(openMainAgent(agents, '.b', 's3')).toBe('.b:3');
  });
});
