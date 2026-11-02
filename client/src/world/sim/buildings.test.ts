// One building per office, side by side: rooms and characters in the building of their office, each building with
// its own spots and elevators, a building that grows pushes the next ones (and their people) east.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { COL_W, CORE_COLS, TILE } from '../constants';
import { BUILDING_GAP_COLS } from '../layout/building';
import { inSpan } from './spots';
import { Sim } from './sim';

const T0 = 1_700_000_000_000;
const theme: RoomTheme = { carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black' };
const appearance = { skin: '#f0c8a0', hair: '#3a2a20', hairStyle: 'short', eyes: '#222', top: '#3f7fd8', topAccent: '#fff', topStyle: 'tshirt', bottom: '#333', shoes: '#111', accessory: 'none', accessoryColor: '#000', lanyard: null, look: 'm' } as Appearance;
const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;

const room = (id: string, office?: string): RoomInfo => ({ id, name: id, path: id, slot: 0, seed: id.length * 31, createdAt: T0, ...(office ? { office } : {}) });
const agent = (id: string, roomId: string, office?: string): AgentInfo =>
  ({
    id,
    kind: 'main',
    roomId,
    name: id,
    look: 'f',
    role: 'Main agent',
    sessionId: `s-${id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...(office ? { office } : {}),
  }) as AgentInfo;
const office = (id: string): OfficeInfo => ({ id, name: id.toUpperCase(), folder: `/${id}`, workers: [] });
const snap = (rooms: RoomInfo[], agents: AgentInfo[], offices?: OfficeInfo[]): OfficeSnapshot => ({
  rev: 1,
  serverTime: T0,
  rooms,
  agents,
  accounts: [{ id: '.claude', short: 'C', name: 'Account C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
  meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  ...(offices ? { team: { workers: [], agy: [], offices } } : {}),
});
const newSim = () => new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
const run = (sim: Sim, ms: number, from = T0) => {
  for (let t = 0; t < ms; t += 100) sim.update(0.1, from + t);
};

describe('one building per office', () => {
  it('a single office: one building at column 0, like before offices', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('/a', 'o1')], [agent('a', '/a', 'o1')], [office('o1')]), T0);
    expect(sim.building.buildings.map((b) => [b.id, b.col0, b.cols])).toEqual([['o1', 0, CORE_COLS + 1]]);
    expect(sim.rooms.get('/a')!.slot).toBe(0);
    expect(sim.building.core.map((a) => a.id)).not.toContain('core:recepcao@o1');
  });

  it('two offices: rooms and characters in their own building; absent office = the first', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('/a', 'o1'), room('/b', 'o2'), room('/c')], [agent('a', '/a', 'o1'), agent('b', '/b', 'o2'), agent('c', '/c')], [office('o1'), office('o2')]), T0);
    const [b1, b2] = sim.building.buildings;
    expect(b2.col0).toBe(b1.cols + BUILDING_GAP_COLS);
    const rb = sim.rooms.get('/b')!;
    expect(rb.office).toBe('o2');
    expect(rb.local).toBe(0);
    expect(rb.layout.rect.x).toBe((b2.col0 + CORE_COLS) * COL_W);
    // /a and /c share the first building (slots 0 and 1)
    expect([sim.rooms.get('/a')!.local, sim.rooms.get('/c')!.local].sort()).toEqual([0, 1]);
    const span2 = sim.within('o2');
    const cb = sim.chars.get('b')!;
    expect(cb.office).toBe('o2');
    expect(inSpan(cb, span2)).toBe(true);
    expect(sim.spots.get(cb.homeSpot)!.areaId).toBe('/b');
    expect(inSpan(sim.chars.get('c')!, sim.within('o1'))).toBe(true);
    // every elevator spot of each building has an Elevator
    expect(sim.elevators.length).toBe(4);
  });

  it('the first building grows: the second one and its people move east with it', () => {
    const sim = newSim();
    const offices = [office('o1'), office('o2')];
    sim.applySnapshot(snap([room('/a', 'o1'), room('/b', 'o2')], [agent('a', '/a', 'o1'), agent('b', '/b', 'o2')], offices), T0);
    const before = sim.building.buildings[1].col0;
    const xb = sim.chars.get('b')!.x;
    // three more rooms in the first office: it needs one more column
    const more = [room('/a2', 'o1'), room('/a3', 'o1'), room('/a4', 'o1')];
    sim.applySnapshot(snap([room('/a', 'o1'), room('/b', 'o2'), ...more], [agent('a', '/a', 'o1'), agent('b', '/b', 'o2')], offices), T0 + 100);
    const after = sim.building.buildings[1].col0;
    expect(after).toBe(before + 1);
    expect(sim.chars.get('b')!.x).toBe(xb + COL_W * TILE);
    expect(sim.rooms.get('/b')!.layout.rect.x).toBe((after + CORE_COLS) * COL_W);
    run(sim, 3_000, T0 + 200);
    expect(inSpan(sim.chars.get('b')!, sim.within('o2'))).toBe(true);
  });

  it('a character whose office changes reappears in the other building', () => {
    const sim = newSim();
    const offices = [office('o1'), office('o2')];
    sim.applySnapshot(snap([room('/a', 'o1')], [agent('a', '/a', 'o1')], offices), T0);
    sim.applySnapshot(snap([room('/a', 'o1')], [agent('a', '/a', 'o2')], offices), T0 + 100);
    const ch = sim.chars.get('a')!;
    expect(ch.office).toBe('o2');
    expect(inSpan(ch, sim.within('o2'))).toBe(true);
    // its room is in the other building: no desk there
    expect(ch.homeSpot).toBeNull();
  });

  it('an office deleted: its rooms move to the first building', () => {
    const sim = newSim();
    sim.applySnapshot(snap([room('/b', 'o2')], [agent('b', '/b', 'o2')], [office('o1'), office('o2')]), T0);
    sim.applySnapshot(snap([room('/b', 'o2')], [agent('b', '/b', 'o2')], [office('o1')]), T0 + 100);
    expect(sim.building.buildings).toHaveLength(1);
    expect(sim.rooms.get('/b')!.office).toBe('o1');
    expect(sim.chars.get('b')!.office).toBe('o1');
    expect(inSpan(sim.chars.get('b')!, sim.within('o1'))).toBe(true);
  });
});
