// Offices from the snapshot: the list, the one shown, its room, boss, focus (dimming) and jobs.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeInfo, OfficeSnapshot, RoomInfo, TeamInfo } from '../../../shared/types';
import { agyBossOffice, folderOverlap, folderProblem, jobInOffice, officeBoss, officeFocus, officeForWorker, officeOfSelection, officePlan, officeRoom, otherOfficesOf, pickOffice, sameFocus, teamOffices, workerAgentIds } from './offices';

const office = (id: string, extra: Partial<OfficeInfo> = {}): OfficeInfo => ({ id, name: id.toUpperCase(), folder: `/p/${id}`, workers: [], ...extra });
const room = (id: string, path: string, extra: Partial<RoomInfo> = {}) => ({ id, name: id, path, ...extra }) as RoomInfo;
const agent = (id: string, roomId: string, extra: Partial<AgentInfo> = {}) => ({ id, roomId, name: id, ...extra }) as AgentInfo;
type Snap = Pick<OfficeSnapshot, 'agents' | 'rooms' | 'team'>;
const team = (offices: OfficeInfo[] | undefined, extra: Partial<TeamInfo> = {}): TeamInfo => ({ workers: [], agy: [], ...(offices ? { offices } : {}), ...extra });

describe('offices', () => {
  it('an older server: the single team becomes office "main" without a folder', () => {
    expect(teamOffices(team(undefined, { workers: ['acc2'], bossAccount: '.claude', bossKind: 'claude' }))).toEqual([
      { id: 'main', name: 'Office', folder: '', workers: ['acc2'], bossAccount: '.claude', bossKind: 'claude' },
    ]);
    expect(teamOffices(undefined)).toEqual([]);
  });

  it('the saved office, else the first', () => {
    const list = [office('a'), office('b')];
    expect(pickOffice(list, 'b')?.id).toBe('b');
    expect(pickOffice(list, 'gone')?.id).toBe('a');
    expect(pickOffice([], 'a')).toBeUndefined();
  });

  it('room: the server roomId, else the room with the folder path', () => {
    const rooms = [room('r1', '/p/a'), room('r2', '/p/b')];
    expect(officeRoom({ rooms }, office('x', { roomId: 'r2' }))?.id).toBe('r2');
    expect(officeRoom({ rooms }, office('a'))?.id).toBe('r1');
    expect(officeRoom({ rooms }, office('c'))).toBeUndefined();
    expect(officeRoom({ rooms }, office('a', { folder: '' }))).toBeUndefined();
  });

  it('boss: bossAgentId or pendingBoss; any crowned agent only with one office', () => {
    const agents = [agent('b1', 'r1', { boss: true }), agent('b2', 'r2', { boss: true })];
    const two = team([office('a', { bossAgentId: 'b2' }), office('b')]);
    expect(officeBoss({ agents, team: two }, two.offices![0])?.id).toBe('b2');
    expect(officeBoss({ agents, team: two }, two.offices![1])).toBeUndefined();
    const one = team([office('a', { pendingBoss: 'b1' })]);
    expect(officeBoss({ agents, team: one }, one.offices![0])?.id).toBe('b1');
    const old = team(undefined);
    expect(officeBoss({ agents: [agents[0]], team: old }, teamOffices(old)[0])?.id).toBe('b1');
  });

  it('focus: the building of the office (rooms by room.office, characters by agent.office; absent = the first); none with one office', () => {
    const rooms = [room('ra', '/p/a'), room('rw', '/agy'), room('rb', '/p/b', { office: 'b' }), room('rw@b', '/agy', { office: 'b' })];
    const agents = [
      agent('boss-a', 'ra', { boss: true }),
      agent('side-a', 'ra'),
      agent('sub', 'ra', { parentId: 'boss-a' }),
      agent('agy:acc2', 'rw'),
      agent('boss-b', 'rb', { boss: true, office: 'b' }),
      agent('sub-b', 'rb', { parentId: 'boss-b' }),
      agent('agy:acc2@b', 'rw@b', { office: 'b' }),
    ];
    const offices = [office('a', { bossAgentId: 'boss-a', workers: ['acc2'] }), office('b', { bossAgentId: 'boss-b', workers: ['acc2'] })];
    const snap: Snap = { rooms, agents, team: team(offices) };
    const f = officeFocus(snap, offices[0])!;
    expect([...f.roomIds].sort()).toEqual(['ra', 'rw']);
    expect([...f.agentIds].sort()).toEqual(['agy:acc2', 'boss-a', 'side-a', 'sub']);
    const g = officeFocus(snap, offices[1])!;
    expect([...g.roomIds].sort()).toEqual(['rb', 'rw@b']);
    expect([...g.agentIds].sort()).toEqual(['agy:acc2@b', 'boss-b', 'sub-b']);
    expect(officeFocus({ ...snap, team: team([offices[0]]) }, offices[0])).toBeNull();
    expect(sameFocus(f, officeFocus(snap, offices[0]))).toBe(true);
    expect(f.office).toBe('a');
    expect(g.office).toBe('b');
    expect(sameFocus(f, g)).toBe(false);
    expect(sameFocus(f, { ...f, office: 'b' })).toBe(false);
  });

  it("selection: the office of the selected character's or room's building; none with one office", () => {
    const offices = [office('a'), office('b')];
    const snap: Snap = { rooms: [room('ra', '/p/a'), room('rb', '/p/b', { office: 'b' })], agents: [agent('x', 'ra'), agent('y', 'rb', { office: 'b' }), agent('ys', 'rb', { parentId: 'y' })], team: team(offices) };
    expect(officeOfSelection(snap, { type: 'agent', id: 'x' })).toBe('a');
    expect(officeOfSelection(snap, { type: 'agent', id: 'ys' })).toBe('b');
    expect(officeOfSelection(snap, { type: 'room', id: 'rb' })).toBe('b');
    expect(officeOfSelection(snap, { type: 'agent', id: 'gone' })).toBeUndefined();
    expect(officeOfSelection(snap, null)).toBeUndefined();
    expect(officeOfSelection({ ...snap, team: team([offices[0]]) }, { type: 'agent', id: 'y' })).toBeUndefined();
  });

  it("workers' characters: the one in that office (agentIds), else the first (agentId), else agy:accN", () => {
    const sessions = [{ worker: 'claude:.claude-w', kind: 'claude' as const, agentId: 'claude:w', agentIds: { a: 'claude:w', b: 'claude:w@b' }, account: '.claude-w' }];
    expect([...workerAgentIds({ sessions }, ['claude:.claude-w', 'acc2'], 'b')]).toEqual(['claude:w@b', 'agy:acc2']);
    expect([...workerAgentIds({ sessions }, ['claude:.claude-w'], 'c')]).toEqual(['claude:w']);
    expect([...workerAgentIds({ sessions }, ['claude:.claude-w'])]).toEqual(['claude:w']);
  });

  it('jobs: by office; a job without one counts for the first office', () => {
    const list = [office('a'), office('b')];
    expect(jobInOffice({ office: 'b' }, list[1], list)).toBe(true);
    expect(jobInOffice({ office: 'b' }, list[0], list)).toBe(false);
    expect(jobInOffice({}, list[0], list)).toBe(true);
    expect(jobInOffice({}, list[1], list)).toBe(false);
  });

  it("to-do list: the plan of the office's folder room, else of its folder (read by the server)", () => {
    const plan = { file: 'HANDOFF.md', mtime: 1, heading: 'Next', items: [] };
    expect(officePlan({ rooms: [room('ra', '/p/a', { plan })] }, office('a'))).toEqual({ name: 'ra', target: { room: 'ra' }, plan });
    expect(officePlan({ rooms: [room('ra', '/p/a')] }, office('a'))?.plan).toBeUndefined();
    // nobody works in the folder (e.g. the boss sits in ~): the folder's own list, edited through the office
    expect(officePlan({ rooms: [] }, office('a', { plan }))).toEqual({ name: 'a', target: { office: 'a' }, plan });
    expect(officePlan({ rooms: [] }, office('a'))).toEqual({ name: 'a', target: { office: 'a' } });
    expect(officePlan({ rooms: [] }, office('a', { folder: '' }))).toBeUndefined();
  });

  it('workers shared between offices, an agy boss in one office only', () => {
    const list = [office('a', { workers: ['acc2'] }), office('b', { workers: ['acc2', 'acc4'], bossAccount: 'x@agy', bossKind: 'agy' })];
    expect(officeForWorker(list[0], 'acc2')).toBe('a');
    expect(officeForWorker(list[0], 'acc4')).toBeUndefined();
    expect(otherOfficesOf(list, 'acc2', 'a')).toEqual(['B']);
    expect(agyBossOffice(list, 'x@agy')?.id).toBe('b');
    expect(agyBossOffice(list, 'y@agy')).toBeUndefined();
  });

  it('folder: absolute and unique', () => {
    const list = [office('a'), office('b', { folder: '' })];
    expect(folderProblem(list, '')).toBe('empty');
    expect(folderProblem(list, 'rel/x')).toBe('relative');
    expect(folderProblem(list, '/p/a/')).toBe('used:A');
    expect(folderProblem(list, '/p/a', 'a')).toBe('');
    expect(folderProblem(list, '/p/new')).toBe('');
    expect(folderProblem(list, '/')).toBe('root');
    expect(folderProblem(list, 'C:\\')).toBe('root');
    // office folders never overlap
    expect(folderProblem(list, '/p/a/sub')).toBe('inside:A');
    expect(folderProblem(list, '/p')).toBe('contains:A');
    expect(folderProblem(list, '/p/ab')).toBe('');
  });

  it('an office whose folder overlaps another (a team file from before the rule) is pointed out', () => {
    const list = [office('a', { folder: '/home' }), office('b', { folder: '/home/x' }), office('c'), office('d', { folder: '' })];
    expect(folderOverlap(list, list[0])?.id).toBe('b');
    expect(folderOverlap(list, list[1])?.id).toBe('a');
    expect(folderOverlap(list, list[2])).toBeUndefined();
    expect(folderOverlap(list, list[3])).toBeUndefined();
  });
});
