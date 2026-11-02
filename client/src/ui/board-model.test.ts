// What the Board shows: the boss's to-do list and the important news.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../shared/types';
import { bossPlan, hasBoard, importantNews, officeItems } from './board-model';

function agent(id: string, roomId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, kind: 'main', roomId, name: id, tasks: [], ...extra } as AgentInfo;
}

function room(id: string, extra: Partial<RoomInfo> = {}): RoomInfo {
  return { id, name: id, path: `/p/${id}`, slot: 0, seed: 0, createdAt: 0, ...extra };
}

function snap(agents: AgentInfo[], rooms: RoomInfo[], extra: Partial<OfficeSnapshot> = {}): OfficeSnapshot {
  return { rev: 1, serverTime: 0, agents, rooms, accounts: [], ...extra } as OfficeSnapshot;
}

const plan = (mtime: number) => ({ file: 'HANDOFF.md', mtime, heading: 'Next', items: [{ text: 'x' }] });

describe('board model', () => {
  it("to-do list: the boss's folder (with or without a list); without a boss, the newest list", () => {
    const rooms = [room('old', { plan: plan(1) }), room('new', { plan: plan(9) }), room('boss', { plan: plan(5) }), room('bare')];
    expect(bossPlan(snap([agent('b', 'boss', { boss: true })], rooms))?.target).toEqual({ room: 'boss' });
    expect(bossPlan(snap([agent('b', 'bare', { boss: true })], rooms))).toEqual({ name: 'bare', target: { room: 'bare' } });
    expect(bossPlan(snap([agent('a', 'old')], rooms))?.target).toEqual({ room: 'new' });
    expect(bossPlan(snap([], [room('bare')]))).toBeUndefined();
  });

  it("with offices: the office folder's list; jobs by office", () => {
    const rooms = [room('a', { plan: plan(1) }), room('b', { plan: plan(9) })];
    const offices = [
      { id: 'oa', name: 'A', folder: '/p/a', workers: [] },
      { id: 'ob', name: 'B', folder: '/p/b', workers: [] },
      { id: 'oc', name: 'C', folder: '/p/c', workers: [] },
      { id: 'od', name: 'D', folder: '', workers: [], bossAgentId: 'bd' },
    ];
    const s = snap([agent('bd', 'b', { boss: true })], rooms, { team: { workers: [], agy: [], offices } });
    expect(bossPlan(s, offices[0])?.target).toEqual({ room: 'a' });
    // no room in its folder: the folder itself (its list, read by the server, once there is one)
    expect(bossPlan(s, offices[2])).toEqual({ name: 'c', target: { office: 'oc' } });
    expect(bossPlan(s, offices[3])?.target).toEqual({ room: 'b' });
    const items = [{ id: 1, office: 'oa' }, { id: 2, office: 'ob' }, { id: 3 }];
    expect(officeItems(items, offices[0]).map((i) => i.id)).toEqual([1]);
    expect(officeItems(items, offices[1]).map((i) => i.id)).toEqual([2]);
    expect(officeItems(items, undefined).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('important news: failures and quota hits, and who waits for you, newest first', () => {
    const news = [
      { id: 'c', at: 1, kind: 'commit' as const, icon: '📝', text: 'commit' },
      { id: 'f', at: 2, kind: 'failed' as const, icon: '⚠️', text: 'acc2 failed' },
      { id: 'q', at: 3, kind: 'quota' as const, icon: '🪫', text: 'acc3 out of quota' },
      { id: 'd', at: 4, kind: 'done' as const, icon: '✅', text: 'done' },
    ];
    const waiting = agent('w', 'r', { status: 'waiting', waitingFor: 'approve Bash', statusSince: 5 } as Partial<AgentInfo>);
    expect(importantNews(snap([waiting, agent('x', 'r')], [], { news }), 10).map((n) => n.text)).toEqual(['w: approve Bash', 'acc3 out of quota', 'acc2 failed']);
  });

  it('button: shown when any tab has something', () => {
    expect(hasBoard(snap([], [room('r')]))).toBe(false);
    expect(hasBoard(snap([], [room('r', { board: { items: [] } })]))).toBe(true);
    expect(hasBoard(snap([], [], { news: [{ id: 'n', at: 0, kind: 'commit', icon: '📝', text: 'x' }] }))).toBe(true);
    expect(hasBoard(snap([agent('a', 'r', { boss: true })], [room('r')]))).toBe(true);
  });

  it('a ghost is news, with its PID', () => {
    const news = [{ id: 'g', at: 1, kind: 'ghost' as const, icon: '👻', text: 'two looks hung', detail: 'silent for 10min · PID 42 · nothing was stopped' }];
    expect(importantNews(snap([], [], { news }), 10).map((n) => n.text)).toEqual(['two looks hung · silent for 10min · PID 42 · nothing was stopped']);
  });

  it('a rules refusal says what was refused', () => {
    const news = [
      { id: 'a', at: 1, kind: 'rule' as const, icon: '📜', text: 'acc2 stopped by the rules of X', detail: '~/.ssh/id_ed25519' },
      { id: 'b', at: 2, kind: 'rule' as const, icon: '📜', text: 'acc2 stopped by the rules of X', detail: 'git push' },
    ];
    expect(importantNews(snap([], [], { news }), 10).map((n) => n.text)).toEqual(['acc2 stopped by the rules of X · git push', 'acc2 stopped by the rules of X · ~/.ssh/id_ed25519']);
  });
});
