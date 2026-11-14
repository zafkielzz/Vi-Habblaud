// The office tab menu: its header (what the office is) and its items (what can be done).
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, OfficeInfo, OfficeSnapshot, RoomInfo } from '../../../shared/types';
import { officeMenuItems, officeSummary, workerShortName, type OfficeMenuEnv } from './office-menu';

function room(id: string, extra: Partial<RoomInfo> = {}): RoomInfo {
  return { id, name: id, path: `/p/${id}`, slot: 0, seed: 0, createdAt: 0, ...extra };
}

const offices: OfficeInfo[] = [
  { id: 'a', name: 'A', folder: '/p/a', workers: ['acc1', 'claude:.claude-b'], bossAgentId: 'boss' },
  { id: 'b', name: 'B', folder: '', workers: [], waitingBoss: 'Raul' },
];

const snap = {
  rev: 1,
  serverTime: 0,
  agents: [{ id: 'boss', kind: 'main', roomId: 'a', name: 'Ana', status: 'working', tasks: [] } as unknown as AgentInfo],
  rooms: [
    room('a', {
      plan: { file: 'HANDOFF.md', mtime: 1, heading: 'Next', items: [{ text: 'one', done: true }, { text: 'two' }, { text: 'three' }] },
      board: {
        items: [
          { id: '1', agentId: 'x', worker: 'acc1', text: 'j', status: 'working', by: 'boss', at: 1, office: 'a' },
          { id: '2', agentId: 'x', worker: 'acc1', text: 'j', status: 'done', by: 'boss', at: 1, office: 'a' },
          { id: '3', agentId: 'x', worker: 'acc1', text: 'j', status: 'working', by: 'boss', at: 1, office: 'b' },
        ],
      },
    }),
  ],
  accounts: [
    { id: 'g1', name: 'nguyenvana (Agy)' },
    { id: '.claude-b', name: 'Account B' },
  ],
  team: { workers: [], agy: [{ acc: 'acc1', account: 'g1' }], offices },
} as unknown as OfficeSnapshot;

function env(extra: Partial<OfficeMenuEnv> = {}): OfficeMenuEnv {
  return {
    snap,
    shownId: 'a',
    locked: '',
    show: vi.fn(),
    rename: vi.fn(),
    changeFolder: vi.fn(),
    copyFolder: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    ...extra,
  };
}

describe('office tab menu', () => {
  it('header: folder, boss and state, workers by account name, running jobs and to-do of this office', () => {
    expect(officeSummary(snap, offices[0])).toEqual({
      name: 'A',
      folder: '/p/a',
      boss: { name: 'Ana', state: expect.any(String) },
      workers: ['nguyenvana', 'Account B'],
      running: 1,
      todo: { done: 1, total: 3, next: 'two' },
    });
    const b = officeSummary(snap, offices[1]);
    expect(b.folder).toBe('');
    expect(b.boss?.name).toBe('Raul');
    expect(b.workers).toEqual([]);
    expect(b.running).toBe(1);
    expect(b.todo).toBeUndefined();
  });

  it('worker short name falls back to the id', () => {
    expect(workerShortName(snap, 'acc9')).toBe('acc9');
    expect(workerShortName(null, 'claude:x')).toBe('claude:x');
    expect(workerShortName(snap, 'acc9#2')).toBe('acc9#2');
  });

  it('a clone is named after its account, with its session number', () => {
    const s = { accounts: [{ id: 'agy:acc1', name: 'alice (Agy)' }, { id: '.claude-b', name: 'bob' }], team: { agy: [{ acc: 'acc1', account: 'agy:acc1' }] } } as unknown as Parameters<typeof workerShortName>[0];
    expect([workerShortName(s, 'acc1'), workerShortName(s, 'acc1#2'), workerShortName(s, 'claude:.claude-b#3')]).toEqual(['alice', 'alice #2', 'bob #3']);
  });

  it('items: "Show" only for another office, Board / Boss / Worker only when wired, delete last', () => {
    const ids = (o: OfficeInfo, e: OfficeMenuEnv) => officeMenuItems(o, e).map((i) => i.id);
    expect(ids(offices[0], env())).toEqual(['rename', 'folder', 'copy', 'new', 'delete']);
    const full = env({ openBoard: vi.fn(), addBoss: vi.fn(), addWorker: vi.fn(), bossBlocked: '', workerBlocked: '' });
    expect(ids(offices[1], full)).toEqual(['show', 'rename', 'folder', 'copy', 'board', 'boss', 'worker', 'new', 'delete']);
    const del = officeMenuItems(offices[1], full).at(-1)!;
    expect(del.danger).toBe(true);
    expect(del.disabled).toBe('');
    del.run();
    expect(full.remove).toHaveBeenCalledWith('b');
  });

  it('disabled with a reason: locked, no folder to copy, the last office', () => {
    const locked = officeMenuItems(offices[1], env({ locked: 'demo' }));
    const by = (id: string) => locked.find((i) => i.id === id)!;
    expect(by('rename').disabled).toBe('demo');
    expect(by('new').disabled).toBe('demo');
    expect(by('copy').disabled).toBeTruthy();
    expect(by('show').disabled).toBeUndefined();
    const one = { ...snap, team: { ...snap.team!, offices: [offices[0]] } };
    expect(officeMenuItems(offices[0], env({ snap: one })).find((i) => i.id === 'delete')!.disabled).toBeTruthy();
  });

  it('more items can be added as builders', () => {
    const items = officeMenuItems(offices[0], env(), [(o) => ({ id: 'rules', label: `Rules of ${o.name}`, run: () => undefined })]);
    expect(items.map((i) => i.label)).toEqual(['Rules of A']);
  });
});
