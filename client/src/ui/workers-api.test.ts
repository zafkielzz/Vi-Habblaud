import { describe, expect, it } from 'vitest';
import type { WorkerSession } from '../../../shared/types';
import { freeWorkers, jobOpen, sessionAgentIn, sessionAgents, sessionOfAgent, workerKind, workerOfAgent } from './workers-api';

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

  it('＋ Worker: Antigravity and Claude accounts, not workers yet, never the boss account', () => {
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
    expect(freeWorkers(team).map((c) => [c.worker, c.kind])).toEqual([
      ['acc2', 'agy'],
      ['acc4', 'agy'],
      ['claude:.claude-w', 'claude'],
    ]);
    expect(freeWorkers({ ...team, bossAccount: 'agy:acc2' }).map((c) => c.worker)).toEqual(['acc4', 'claude:.claude', 'claude:.claude-w']);
    expect(freeWorkers(undefined)).toEqual([]);
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
    expect(freeWorkers(team, team.offices[0]).map((c) => c.worker)).toEqual(['acc2']);
    expect(freeWorkers(team, { workers: ['acc2'], bossAccount: undefined }).map((c) => c.worker)).toEqual(['acc1', 'claude:.claude']);
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
