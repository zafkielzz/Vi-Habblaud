// Codex terminal history: listing recent rollouts and safely resolving sessions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { codexHome, R, SOURCES, threadId } from '../../test/codex-fixtures';
import { symlinkOrSkip, tempDir } from '../../test/fixtures';
import { CodexHistory } from './history';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const [A, B, SUB, OLD, ARCH] = [1, 2, 3, 4, 5].map(threadId);

function setup() {
  const home = codexHome();
  cleanups.push(home.cleanup);
  const now = Date.now();
  const open = new Set<string>();
  const history = new CodexHistory({
    accounts: () => [{ id: '.codex', dir: home.dir }],
    openAgentOf: (acc, sid) => (open.has(sid) ? `${acc}:${sid}` : undefined),
    now: () => now,
  });
  return { home, history, now, open };
}

describe('Codex history', () => {
  it('lists rollouts from the last 7 days (sessions/ and archived_sessions/), excluding subagents and internal ones', async () => {
    const { home, history, now, open } = setup();
    home.rollout(A, [R.meta(A, { at: now - 3_600_000, cwd: '/projetos/loja' }), R.user(A, 't', 'u', 'Fix the checkout', now - 3_590_000), R.agent(A, 't', 'a', 'ok', now - 3_000_000)]);
    home.rollout(B, [R.meta(B, { at: now - 7_200_000, cwd: '/projetos/api', history: null }), R.legacyUser('old question', now - 7_100_000)], { date: '2026/10/08' });
    home.rollout(SUB, [R.meta(SUB, { at: now - 1_000, sessionId: A, source: SOURCES.sub(A) }), R.user(SUB, 't', 'u', 'sub', now - 900)]);
    home.rollout(OLD, [R.meta(OLD, { at: now - 10 * 86_400_000 })], { mtime: now - 10 * 86_400_000 });
    home.rollout(ARCH, [R.meta(ARCH, { at: now - 60_000, cwd: '/projetos/loja', source: 'vscode' }), R.user(ARCH, 't', 'u', 'archived', now - 50_000)], { archived: true });
    open.add(A);
    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual([ARCH, A, B]);
    expect(list[1]).toMatchObject({
      account: '.codex',
      provider: 'codex',
      sessionId: A,
      project: '/projetos/loja',
      projectDir: '-projetos-loja',
      title: 'Fix the checkout',
      open: true,
      agentId: `.codex:${A}`,
      firstAt: now - 3_600_000,
      lastAt: now - 3_000_000,
    });
    expect(list[2]).toMatchObject({ title: 'old question', open: false });
    expect(list[2].agentId).toBeUndefined();
  });

  it('resolve: only inside account folder, using Codex parser; invalid id 400; .zst and unknown 404', ({ skip }) => {
    const { home, history } = setup();
    const path = home.rollout(A, [R.meta(A), R.user(A, 't', 'u', 'hi')]);
    const r = history.resolve('.codex', A);
    expect('path' in r && r.path).toContain(`rollout-2026-10-09T09-00-00-${A}.jsonl`);
    if ('path' in r) expect(r.createParser().push(R.user(A, 't', 'u2', 'hello'))[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(path).toBeTruthy();
    expect(history.resolve('.codex', '../../etc/passwd')).toEqual({ status: 400, error: 'invalid session id' });
    expect(history.resolve('.outra', A)).toEqual({ status: 404, error: 'unknown account' });
    expect(history.resolve('.codex', B)).toMatchObject({ status: 404 });
    const dir = join(home.dir, 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-01T09-00-00-${B}.jsonl.zst`), 'zst');
    expect(history.resolve('.codex', B)).toMatchObject({ status: 404, error: expect.stringContaining('.zst') });
    // Link outside account folder: rejected.
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(join(outside.dir, 'x.jsonl'), R.meta(SUB));
    symlinkOrSkip(skip, join(outside.dir, 'x.jsonl'), join(dir, `rollout-2026-10-01T09-00-00-${SUB}.jsonl`));
    expect(history.resolve('.codex', SUB)).toMatchObject({ status: 404 });
  });

  it('cache: rollout is only re-read when modified', async () => {
    const { home, history, now } = setup();
    const path = home.rollout(A, [R.meta(A, { at: now - 1_000 }), R.user(A, 't', 'u', 'first', now - 900)]);
    expect((await history.list())[0].title).toBe('first');
    home.append(path, [R.agent(A, 't', 'a', 'response', now - 100)]);
    expect((await history.list())[0].lastAt).toBe(now - 100);
  });
});
