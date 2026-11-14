import { describe, expect, it } from 'vitest';
import type { WorkerSession } from '../../../shared/types';
import { jobOpen, sessionAgentIn, sessionAgents, sessionOfAgent, workerChoiceGroups, workerChoices, workerKind, workerOfAgent } from './workers-api';

const session = (worker: string, agentId: string, extra: Partial<WorkerSession> = {}): WorkerSession => ({
  worker,
  kind: workerKind(worker),
  agentId,
  account: worker,
  ...extra,
});

describe('workers', () => {
  it('kind from the worker id', () => {
    expect(workerKind('acc2')).toBe('agy');
    expect(workerKind('claude:.claude-work')).toBe('claude');
  });

  it('the worker behind a character: its session, else a registered Antigravity profile', () => {
    const team = { workers: ['acc1', 'claude:.claude-w'], sessions: [session('claude:.claude-w', '.claude-w:5')] };
    expect(workerOfAgent(team, { id: '.claude-w:5', provider: 'claude' })).toBe('claude:.claude-w');
    expect(workerOfAgent(team, { id: 'agy:acc1', provider: 'agy' })).toBe('acc1');
    expect(workerOfAgent(team, { id: 'agy:acc3', provider: 'agy' })).toBeUndefined();
    expect(workerOfAgent(team, { id: '.claude:7', provider: 'claude' })).toBeUndefined();
    // no team (older server): every Antigravity worker
    expect(workerOfAgent(undefined, { id: 'agy:acc3', provider: 'agy' })).toBe('acc3');
  });

  it('＋ Worker: Antigravity and Claude accounts, new ones first; one already there or the boss\'s own joins as another session', () => {
    const team = {
      workers: ['acc1'],
      agy: [
        { acc: 'acc1', account: 'agy:acc1' },
        { acc: 'acc2', account: 'agy:acc2' },
        { acc: 'acc4', account: 'agy:acc4' },
      ],
      claude: [
        { worker: 'claude:.claude', account: '.claude' },
        { worker: 'claude:.claude-w', account: '.claude-w' },
      ],
      bossAccount: '.claude',
    };
    expect(workerChoices(team).map((c) => [c.worker, c.kind, c.n, c.own])).toEqual([
      ['acc2', 'agy', 1, false],
      ['acc4', 'agy', 1, false],
      ['claude:.claude-w', 'claude', 1, false],
      // already a worker: one more session of the account
      ['acc1#2', 'agy', 2, false],
      // the boss's own account: the boss is its first session
      ['claude:.claude#2', 'claude', 2, true],
    ]);
    // the next free number, per account
    expect(workerChoices({ ...team, workers: ['acc1', 'acc1#2', 'claude:.claude#2', 'claude:.claude-w'] }).map((c) => c.worker)).toEqual(['acc2', 'acc4', 'acc1#3', 'claude:.claude#3', 'claude:.claude-w#2']);
    // an Antigravity boss's own account is never offered (agy-ask knows that boss by its profile)
    expect(workerChoices({ ...team, bossAccount: 'agy:acc2' }).map((c) => c.worker)).toEqual(['acc4', 'claude:.claude', 'claude:.claude-w', 'acc1#2']);
    expect(workerChoices(undefined)).toEqual([]);
  });

  it('＋ Worker has two groups: accounts to add (not in the office yet) and sessions to clone (already there, or the boss\'s own)', () => {
    const team = {
      workers: ['acc1', 'acc4#2'],
      agy: [
        { acc: 'acc1', account: 'agy:acc1' },
        { acc: 'acc2', account: 'agy:acc2' },
        { acc: 'acc4', account: 'agy:acc4' },
      ],
      claude: [
        { worker: 'claude:.claude', account: '.claude' },
        { worker: 'claude:.claude-w', account: '.claude-w' },
      ],
      bossAccount: '.claude',
    };
    const ids = (list: Array<{ worker: string }>) => list.map((c) => c.worker);
    const groups = workerChoiceGroups(workerChoices(team));
    expect(ids(groups.add)).toEqual(['acc2', 'claude:.claude-w']);
    // acc4 has only its session #2 left: still an account of the office, so it is cloned (its plain id is free again)
    expect(ids(groups.clone)).toEqual(['acc1#2', 'acc4', 'claude:.claude#2']);
    expect(groups.clone.map((c) => c.own)).toEqual([false, false, true]);
    // nobody in the office and no boss: everything is an account to add
    const empty = workerChoiceGroups(workerChoices({ ...team, workers: [], bossAccount: undefined }));
    expect(ids(empty.add)).toEqual(['acc1', 'acc2', 'acc4', 'claude:.claude', 'claude:.claude-w']);
    expect(empty.clone).toEqual([]);
    // every account already there: nothing to add
    const full = workerChoiceGroups(workerChoices({ ...team, workers: ['acc1', 'acc2', 'acc4', 'claude:.claude-w'] }));
    expect(ids(full.add)).toEqual([]);
    expect(ids(full.clone)).toEqual(['acc1#2', 'acc2#2', 'acc4#2', 'claude:.claude#2', 'claude:.claude-w#2']);
    expect(workerChoiceGroups([])).toEqual({ add: [], clone: [] });
  });

  it("＋ Worker in an office: another office's workers are offered, an Antigravity boss anywhere is not", () => {
    const team = {
      workers: [],
      agy: [
        { acc: 'acc1', account: 'agy:acc1' },
        { acc: 'acc2', account: 'agy:acc2' },
        { acc: 'acc4', account: 'agy:acc4' },
      ],
      claude: [{ worker: 'claude:.claude', account: '.claude' }],
      offices: [
        { id: 'a', name: 'A', folder: '/a', workers: ['acc1'], bossAccount: '.claude', bossKind: 'claude' as const },
        { id: 'b', name: 'B', folder: '/b', workers: ['acc1'], bossAccount: 'agy:acc4', bossKind: 'agy' as const },
      ],
    };
    expect(workerChoices(team, team.offices[0]).map((c) => c.worker)).toEqual(['acc2', 'acc1#2', 'claude:.claude#2']);
    expect(workerChoices(team, { workers: ['acc2'], bossAccount: undefined }).map((c) => c.worker)).toEqual(['acc1', 'claude:.claude', 'acc2#2']);
  });

  it('open jobs', () => {
    expect(['queued', 'working', 'done', 'failed', 'cancelled'].map(jobOpen)).toEqual([true, true, false, false, false]);
  });

  it('one character per office: any of them finds the session; the one of an office, else the first', () => {
    const s = { worker: 'acc2', kind: 'agy', agentId: 'agy:acc2', agentIds: { a: 'agy:acc2', b: 'agy:acc2@b' }, account: 'acc2' } as WorkerSession;
    expect(sessionOfAgent({ sessions: [s] }, 'agy:acc2@b')).toBe(s);
    expect(workerOfAgent({ workers: [], sessions: [s] }, { id: 'agy:acc2@b', provider: 'agy' })).toBe('acc2');
    expect(sessionAgentIn(s, 'b')).toBe('agy:acc2@b');
    expect(sessionAgentIn(s, 'zz')).toBe('agy:acc2');
    expect(sessionAgentIn({ agentId: 'claude:w' }, 'b')).toBe('claude:w');
    expect(sessionAgents(s)).toEqual(['agy:acc2', 'agy:acc2@b']);
  });
});
