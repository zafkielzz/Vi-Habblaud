// City state: local server snapshot (WorldSceneSnapshot), area per chunk (replaces), patch (merges,
// replaces with `lot` and removes), chunks outside 3x3 evicted, players (join, move, leave; never self),
// effects (pos, afk, profile, notice), likes and minimap.
import { describe, expect, it } from 'vitest';
import type { WorldSceneMe, WorldSceneSnapshot } from '../../../../shared/world/api';
import type { WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';
import { sampleBuildingDetail } from '../../../../shared/world/visit-sample';
import { CityState } from './state';

function building(id: string, x: number, y: number, extra: Partial<WorldBuildingPublic> = {}): WorldBuildingPublic {
  return { id, lot: { district: 'centro', x, y }, owner: { id, name: `Owner ${id}`, country: 'BR' }, state: 'online', theme: 'none', floors: 3, agents: { total: 3, working: 1, waiting: 1, idle: 1 }, rev: 1, likes: 2, sinceMonth: '2026-10', ...extra };
}

function player(id: string, x: number, y: number): WorldPlayerPublic {
  return { id, name: `Player ${id}`, look: 'f', parts: {}, traits: ['games', 'piadas'], likesReceived: 1, pos: { x, y, dir: 's', moving: false }, where: 'street' };
}

const ME: WorldSceneMe = { id: 'p_me', name: 'Me', look: 'm', parts: {}, traits: ['cafeina'] };

function snap(extra: Partial<WorldSceneSnapshot> = {}): WorldSceneSnapshot {
  return { stream: 's1', connected: true, viewing: true, district: 'centro', afk: false, me: ME, chunks: [], players: [], minimap: null, ...extra };
}

describe('local server snapshot (WorldSceneSnapshot)', () => {
  it('reads stream, connection, self with building id, position, afk, chunks, and null minimap', () => {
    const s = new CityState();
    s.applySnapshot(snap({ afk: true, me: { ...ME, buildingId: 'm' }, pos: { x: 58, y: 24, dir: 's', moving: false }, chunks: [{ chunk: 'centro:0,0', rev: 4, buildings: [building('m', 4, 1)] }], players: [player('x', 1, 1)] }), 0);
    expect(s).toMatchObject({ connected: true, afk: true, district: 'centro', startPos: { x: 58, y: 24 }, myBuildingId: 'm' });
    expect(s.myBuilding()?.id).toBe('m');
    expect(s.minimap).toEqual([]);
    s.applySnapshot(snap({ connected: false }), 0);
    expect(s.connected).toBe(false);
  });

  it('without `buildingId` in welcome (building created afterwards), own building matches my id', () => {
    const s = new CityState();
    s.applySnapshot(snap({ chunks: [{ chunk: 'centro:0,0', rev: 1, buildings: [building('p_me', 3, 0), building('a', 4, 0)] }] }), 0);
    expect(s.myBuilding()?.lot).toMatchObject({ x: 3, y: 0 });
  });

  it('new snapshot replaces entire state (reconnection): omitted entries are removed', () => {
    const s = new CityState();
    s.applySnapshot(snap({ chunks: [{ chunk: 'c', rev: 1, buildings: [building('a', 3, 0)] }], players: [player('x', 1, 1)] }), 0);
    s.applySnapshot(snap({ chunks: [{ chunk: 'c', rev: 7, buildings: [building('b', 4, 0)] }] }), 10);
    expect([...s.buildings.keys()]).toEqual(['b']);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.players.size).toBe(0);
    expect(s.chunkRev.get('c')).toBe(7);
  });
});

describe('CityState', () => {
  it('snapshot: buildings by lot, own building, players (except self), and minimap', () => {
    const s = new CityState();
    s.applySnapshot(snap({ me: { ...ME, buildingId: 'm' }, chunks: [{ chunk: 'centro:0,0', rev: 3, buildings: [building('a', 3, 0), building('m', 4, 1)] }], players: [player('x', 1, 1), player('p_me', 2, 2)], minimap: [{ x: 1, y: 0, lit: 4 }] }), 0);
    expect(s.buildingAt({ x: 3, y: 0 })?.id).toBe('a');
    expect(s.myBuilding()?.id).toBe('m');
    expect([...s.players.keys()]).toEqual(['x']);
    expect(s.chunkRev.get('centro:0,0')).toBe(3);
    expect(s.minimap).toEqual([{ x: 1, y: 0, lit: 4 }]);
  });

  it('area replaces entire chunk (omitted entries leave the city)', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0), building('b', 4, 0)] }, 0);
    const v = s.version;
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 2, buildings: [building('b', 4, 0, { likes: 9 })] }, 0);
    expect(s.buildings.has('a')).toBe(false);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.buildingAt({ x: 4, y: 0 })?.likes).toBe(9);
    expect(s.version).toBeGreaterThan(v);
  });

  it('area.patch merges only changed fields, accepts entire new building, and removes `removed` ids', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0), building('b', 4, 0)] }, 0);
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 2, changes: [{ id: 'a', state: 'away' }, building('n', 5, 0), { id: 'unknown', likes: 3 }], removed: ['b'] }, 0);
    expect(s.buildings.get('a')?.state).toBe('away');
    expect(s.buildings.get('a')?.owner.name).toBe('Owner a');
    expect(s.buildingAt({ x: 5, y: 0 })?.id).toBe('n');
    expect(s.buildings.has('b')).toBe(false);
    expect(s.buildings.has('unknown')).toBe(false);
    expect(s.chunkRev.get('c:0,0')).toBe(2);
  });

  it('area.patch item with `lot` replaces entire building: omitted fields (discreet mode) disappear', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0, { closed: true })] }, 0);
    const { agents: _agents, closed: _closed, ...discreet } = building('a', 3, 0, { rev: 2 });
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 2, changes: [discreet] }, 0);
    expect(s.buildings.get('a')).toEqual(discreet);
    expect(s.buildings.get('a')).not.toHaveProperty('agents');
    expect(s.buildings.get('a')).not.toHaveProperty('closed');
    // with `lot` but missing other fields, not a valid building: retains existing
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 3, changes: [{ id: 'a', lot: { district: 'centro', x: 9, y: 9 } }] }, 0);
    expect(s.buildings.get('a')?.lot).toEqual({ district: 'centro', x: 3, y: 0 });
  });

  it('a building changing lots frees its old lot', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0)] }, 0);
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 2, changes: [building('a', 4, 0, { rev: 2 })] }, 0);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.buildingAt({ x: 4, y: 0 })?.id).toBe('a');
  });

  it('retains only 3x3 chunks around position (server does not notify on unsubscribe)', () => {
    const s = new CityState();
    // chunk (0,0) = blocks 0..1 x 0..1; chunk (2,0) = blocks 4..5: far from plaza
    s.applySnapshot(snap({ chunks: [{ chunk: 'centro:0,0', rev: 1, buildings: [building('perto', 3, 0)] }, { chunk: 'centro:2,0', rev: 5, buildings: [building('longe', 12, 0)] }] }), 0);
    expect(s.keepAround(21, 15)).toBe(true);
    expect([...s.buildings.keys()]).toEqual(['perto']);
    expect(s.buildingAt({ x: 12, y: 0 })).toBeUndefined();
    expect(s.chunkRev.has('centro:2,0')).toBe(false);
    expect(s.keepAround(21, 15)).toBe(false);
    // in block (2,0) (chunk 1,0) both are neighbors; an `area` message restores it
    s.apply({ t: 'area', chunk: 'centro:2,0', rev: 1, buildings: [building('longe', 12, 0)] }, 0);
    expect(s.keepAround(2 * 51 + 2, 15)).toBe(false);
    expect(s.buildings.size).toBe(2);
    // in block (4,0) (chunk 2,0), plaza is excluded
    expect(s.keepAround(4 * 51 + 2, 15)).toBe(true);
    expect([...s.buildings.keys()]).toEqual(['longe']);
  });

  it('players: join, move (ordered samples), leave; self id and unknown players are ignored', () => {
    const s = new CityState();
    s.applySnapshot(snap(), 0);
    s.apply({ t: 'player.join', player: player('x', 1, 1) }, 100);
    s.apply({ t: 'players', chunk: 'c', players: [{ id: 'x', pos: { x: 2, y: 1, dir: 'e', moving: true } }, { id: 'p_me', pos: { x: 9, y: 9, dir: 'e', moving: true } }, { id: 'y', pos: { x: 0, y: 0, dir: 'e', moving: true } }] }, 300);
    const x = s.players.get('x')!;
    expect(x.samples.map((v) => [v.t, v.x])).toEqual([[100, 1], [300, 2]]);
    expect(x.info.pos.x).toBe(2);
    expect(s.players.has('p_me')).toBe(false);
    expect(s.players.has('y')).toBe(false);
    s.apply({ t: 'player.join', player: player('p_me', 1, 1) }, 400);
    expect(s.players.has('p_me')).toBe(false);
    s.apply({ t: 'player.leave', id: 'x' }, 500);
    expect(s.players.size).toBe(0);
  });

  it('scene effects: pos, afk, profile, and notice', () => {
    const s = new CityState();
    s.apply({ t: 'player.join', player: player('x', 1, 1) }, 0);
    expect(s.apply({ t: 'pos', x: 3, y: 4 }, 0)).toEqual({ type: 'pos', x: 3, y: 4 });
    expect(s.apply({ t: 'afk' }, 0)).toEqual({ type: 'afk' });
    const prof = s.apply({ t: 'profile', player: { ...player('x', 7, 7), intro: 'coffee', likesReceived: 9 } }, 0);
    expect(prof?.type).toBe('profile');
    // profile updates data, but position remains based on samples
    expect(s.players.get('x')!.info.likesReceived).toBe(9);
    expect(s.players.get('x')!.info.pos.x).toBe(1);
    expect(s.apply({ t: 'notice', level: 'warn', text: 'rate_limited' }, 0)).toEqual({ type: 'notice', level: 'warn', text: 'rate_limited' });
    expect(s.apply({ t: 'pos', x: 'a' }, 0)).toBeNull();
    expect(s.apply({ t: 'desconhecida' }, 0)).toBeNull();
    expect(s.apply('lixo', 0)).toBeNull();
  });

  it('like.update e minimap', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0)] }, 0);
    s.apply({ t: 'like.update', buildingId: 'a', likes: 40, likedByMe: true }, 0);
    expect(s.buildings.get('a')).toMatchObject({ likes: 40, likedByMe: true });
    const v = s.minimapVersion;
    s.apply({ t: 'minimap', blocks: [{ x: 1.7, y: -1, lit: 3 }, { x: 'x' }] }, 0);
    expect(s.minimap).toEqual([{ x: 1, y: -1, lit: 3 }]);
    expect(s.minimapVersion).toBe(v + 1);
  });
});

describe('CityState: visits (Phase 4)', () => {
  it('building creates interior effect; building.patch passes through; snapshot with `inside` indicates self is inside', () => {
    const s = new CityState();
    const d = sampleBuildingDetail();
    expect(s.apply({ t: 'building', rev: 4, detail: d }, 0)).toEqual({ type: 'building', inside: { id: d.building.id, rev: 4, detail: d } });
    expect(s.apply({ t: 'building', rev: 4, detail: { floors: [] } }, 0)).toBeNull();
    expect(s.apply({ t: 'building.patch', rev: 5, visitors: 2 }, 0)).toEqual({ type: 'building.patch', msg: { t: 'building.patch', rev: 5, visitors: 2 } });
    expect(s.apply({ t: 'building.patch', visitors: 2 }, 0)).toBeNull();
    const base = { stream: 'x', connected: true, viewing: true, afk: false, chunks: [], players: [], minimap: null };
    s.applySnapshot({ ...base, inside: { id: d.building.id, rev: 4, detail: d } }, 0);
    expect(s.inside).toMatchObject({ id: d.building.id, rev: 4 });
    s.applySnapshot(base, 0);
    expect(s.inside).toBeNull();
  });
});
