// World scene state (scene.ts): rev per chunk, resync on gap, building merge and replace, players by
// id, local position (pos, players with local id, move), chunks outside 3×3, and reconstructed commands.
import { describe, expect, it } from 'vitest';
import type { WorldBuildingPublic } from './protocol';
import { parseSceneCommand, reduceSceneBatch, RESYNC_GAP_MS, SceneState } from './scene';
import { sampleBuildingDetail } from './visit-sample';

const ME = 'acc_me';
const WELCOME = {
  t: 'welcome',
  me: { id: ME, name: 'Ana Pixel', look: 'f', parts: { skin: '#e8b48c' }, traits: ['games', 'cafeina'], intro: 'coffee', visibility: { mode: 'live' }, updatedAt: 'x' },
  building: { id: ME },
  city: { districts: ['centro'], lotSize: { w: 14, h: 12 }, blockSize: { w: 3, h: 2 } },
};

function building(id: string, extra: Partial<WorldBuildingPublic> = {}): WorldBuildingPublic {
  return {
    id,
    lot: { district: 'centro', x: 3, y: 0 },
    owner: { id, name: `Dono ${id}` },
    state: 'online',
    theme: 'none',
    floors: 2,
    agents: { total: 3, working: 2, waiting: 1, idle: 0 },
    tokens: { day: 2, week: 3 },
    rev: 1,
    likes: 0,
    sinceMonth: '2026-10',
    ...extra,
  };
}

function player(id: string, x = 21, y = 15) {
  return { id, name: `P ${id}`, look: 'm', parts: {}, traits: ['games', 'cafeina'], likesReceived: 0, pos: { x, y, dir: 's', moving: false }, where: 'street' };
}

function fresh(now = { t: 0 }) {
  const s = new SceneState(() => now.t);
  s.welcome(WELCOME);
  return { s, now };
}

describe('SceneState: buildings per chunk', () => {
  it('area replaces chunk and rev (even if lower); patch requires rev + 1', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 7, buildings: [building('b1')] })).toEqual({ forward: true });
    expect(s.chunkRev('centro:0,0')).toBe(7);
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 5 }] })).toEqual({ forward: true });
    expect(s.building('b1')).toMatchObject({ likes: 5, floors: 2, agents: { total: 3 } });
    // Duplicate or stale: ignored, no resync.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 99 }] })).toEqual({ forward: false });
    expect(s.building('b1')?.likes).toBe(5);
    // Server restarted: area arrives with lower rev and is valid.
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] })).toEqual({ forward: true });
    expect(s.chunkRev('centro:0,0')).toBe(1);
    expect(s.building('b1')).toBeUndefined();
  });

  it('rev gap: requests resync once (every 5 s), does not forward, and next area resolves', () => {
    const { s, now } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 3, buildings: [building('b1')] });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 5, changes: [{ id: 'b1', likes: 1 }] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 6, changes: [] })).toEqual({ forward: false });
    expect(s.building('b1')?.likes).toBe(0);
    now.t += RESYNC_GAP_MS;
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 7, changes: [] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 7, buildings: [building('b1', { likes: 4 })] }).forward).toBe(true);
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 5 }] })).toEqual({ forward: true });
    // After area, a new gap requests immediately.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 10, changes: [] }).resync).toBe('centro:0,0');
  });

  it('patch for missing chunk or partial item of unknown building: resync', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'area.patch', chunk: 'centro:1,0', rev: 2, changes: [] })).toEqual({ forward: false, resync: 'centro:1,0' });
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [{ id: 'bX', likes: 1 }] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.chunkRev('centro:0,0')).toBe(1);
  });

  it('item with lot replaces entire building (discreet mode deletes agents and tokens); without lot merges; removed deletes', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [building('b1'), building('b2')] });
    const discreet = building('b1', { floors: 4 });
    delete discreet.agents;
    delete discreet.tokens;
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [discreet, { id: 'b2', state: 'away' }], removed: [] }).forward).toBe(true);
    expect(s.building('b1')).not.toHaveProperty('agents');
    expect(s.building('b1')).not.toHaveProperty('tokens');
    expect(s.building('b1')?.floors).toBe(4);
    expect(s.building('b2')).toMatchObject({ state: 'away', agents: { total: 3 } });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [building('b3')], removed: ['b2'] }).forward).toBe(true);
    expect(s.building('b2')).toBeUndefined();
    expect(s.building('b3')).toBeDefined();
    // Server-side block: rev increments with empty changes, no gap.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 4, changes: [] })).toEqual({ forward: true });
  });

  it('like.update modifies building across any stored chunk', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [building('b1')] });
    expect(s.apply({ t: 'like.update', buildingId: 'b1', likes: 3, likedByMe: true }).forward).toBe(true);
    expect(s.building('b1')).toMatchObject({ likes: 3, likedByMe: true });
  });
});

describe('SceneState: chunks outside view and local position', () => {
  it('keeps only the 3×3 chunks around position (pos, players with local id, and local move)', () => {
    const { s } = fresh();
    for (const c of ['centro:0,0', 'centro:1,0', 'centro:2,0', 'centro:-1,-1', 'centro:3,3']) s.apply({ t: 'area', chunk: c, rev: 1, buildings: [] });
    // Spawn in plaza: chunk (0,0); neighbors stay.
    expect(s.apply({ t: 'pos', x: 21, y: 15 })).toEqual({ forward: true });
    expect(s.pos).toEqual({ x: 21, y: 15, dir: 's', moving: false });
    expect(s.chunkIds).toEqual(['centro:-1,-1', 'centro:0,0', 'centro:1,0']);
    // Walking east (block 4 belongs to chunk 2): chunk -1,-1 is dropped.
    s.apply({ t: 'area', chunk: 'centro:2,0', rev: 1, buildings: [] });
    s.noteCommand({ t: 'move', x: 4 * 51 + 1, y: 15, dir: 'e', moving: true });
    expect(s.chunkIds).toEqual(['centro:1,0', 'centro:2,0']);
    // Server sends local id in players: validated position.
    s.apply({ t: 'players', chunk: 'centro:0,0', players: [{ id: ME, pos: { x: 30, y: 10, dir: 'w', moving: false } }] });
    expect(s.pos).toEqual({ x: 30, y: 10, dir: 'w', moving: false });
    expect(s.chunkIds).toEqual(['centro:1,0']);
  });

  it('afk lasts until walking or turning, view or profile (identical stationary move does not count)', () => {
    const { s } = fresh();
    s.apply({ t: 'pos', x: 21, y: 15 });
    expect(s.apply({ t: 'afk' }).forward).toBe(true);
    expect(s.afk).toBe(true);
    s.noteCommand({ t: 'move', x: 21, y: 15, dir: 's', moving: false });
    expect(s.afk).toBe(true);
    s.noteCommand({ t: 'move', x: 21, y: 15, dir: 'n', moving: false });
    expect(s.afk).toBe(false);
    s.apply({ t: 'afk' });
    s.noteCommand({ t: 'profile', playerId: 'p1' });
    expect(s.afk).toBe(false);
  });
});

describe('SceneState: players', () => {
  it('join adds (and replaces profile), players only updates existing, leave removes; local id never becomes player', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'player.join', player: player('p1') }).forward).toBe(true);
    expect(s.apply({ t: 'player.join', player: player(ME) })).toEqual({ forward: false });
    expect(s.apply({ t: 'players', chunk: 'centro:0,0', players: [{ id: 'p1', pos: { x: 22, y: 15, dir: 'e', moving: true } }, { id: 'p9', pos: { x: 1, y: 1, dir: 's', moving: false } }] }).forward).toBe(true);
    expect(s.player('p1')?.pos).toEqual({ x: 22, y: 15, dir: 'e', moving: true });
    expect(s.player('p9')).toBeUndefined();
    expect(s.apply({ t: 'player.join', player: { ...player('p1', 23, 15), name: 'New name' } }).forward).toBe(true);
    expect(s.player('p1')).toMatchObject({ name: 'New name', pos: { x: 23 } });
    s.apply({ t: 'greeting', from: 'p1', to: ME, greetingId: 'wave', until: 99 });
    expect(s.player('p1')?.greeting).toEqual({ id: 'wave', until: 99 });
    expect(s.apply({ t: 'player.leave', id: 'p1' }).forward).toBe(true);
    expect(s.playerIds).toEqual([]);
  });

  it('non-scene events do not pass; notices, interior, and profile pass', () => {
    const { s } = fresh();
    for (const t of ['welcome', 'goodbye', 'uplink.ack', 'ping', 'pong', 'qualquer']) expect(s.apply({ t }).forward, t).toBe(false);
    expect(s.apply({ t: 'notice', level: 'warn', text: 'rate_limited' }).forward).toBe(true);
    expect(s.apply({ t: 'profile', player: player('p2') }).forward).toBe(true);
    expect(s.apply({ t: 'building', rev: 1, detail: sampleBuildingDetail() }).forward).toBe(true);
    expect(s.apply({ t: 'building', rev: 1, detail: {} }).forward).toBe(false);
    expect(s.apply({ t: 'visitors', count: 2 }).forward).toBe(true);
    expect(s.apply({ t: 'visitors', count: -1 }).forward).toBe(false);
    expect(s.apply({ t: 'minimap', blocks: [{ x: 1, y: 0, lit: 2 }, { x: 'a' }] }).forward).toBe(true);
    expect(s.minimap).toEqual([{ x: 1, y: 0, lit: 2 }]);
  });

  it('snapshot and fromSnapshot: complete and independent copy', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 2, buildings: [building('b1')] });
    s.apply({ t: 'player.join', player: player('p1') });
    s.apply({ t: 'pos', x: 21, y: 15 });
    const snap = { stream: 'x', connected: true, viewing: true, ...s.snapshot() };
    expect(snap).toMatchObject({ district: 'centro', me: { id: ME, name: 'Ana Pixel', buildingId: ME }, afk: false, minimap: null });
    expect(snap.me).not.toHaveProperty('visibility');
    const copy = SceneState.fromSnapshot(snap);
    expect(copy.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [{ id: 'b1', likes: 9 }] }).forward).toBe(true);
    expect(copy.building('b1')?.likes).toBe(9);
    expect(s.building('b1')?.likes).toBe(0);
    expect(snap.chunks[0]?.buildings[0]?.likes).toBe(0);
  });
});

describe('scene commands', () => {
  it('reconstructed field by field; non-scene (hello, uplink, ping) or malformed becomes null', () => {
    expect(parseSceneCommand({ t: 'move', x: 1.5, y: -2, dir: 'n', moving: true, token: 'secret' })).toEqual({ t: 'move', x: 1.5, y: -2, dir: 'n', moving: true });
    expect(parseSceneCommand({ t: 'view', extra: 1 })).toEqual({ t: 'view' });
    expect(parseSceneCommand({ t: 'view.off' })).toEqual({ t: 'view.off' });
    expect(parseSceneCommand({ t: 'resync' })).toEqual({ t: 'resync' });
    expect(parseSceneCommand({ t: 'resync', chunk: 'centro:0,0' })).toEqual({ t: 'resync', chunk: 'centro:0,0' });
    // Phase 4: interior of building where player is (never becomes resync of all areas)
    expect(parseSceneCommand({ t: 'resync', building: 'o_7a8b' })).toEqual({ t: 'resync', building: 'o_7a8b' });
    expect(parseSceneCommand({ t: 'profile', playerId: 'p1' })).toEqual({ t: 'profile', playerId: 'p1' });
    expect(parseSceneCommand({ t: 'greet', playerId: 'p1', greetingId: 'wave' })).toEqual({ t: 'greet', playerId: 'p1', greetingId: 'wave' });
    expect(parseSceneCommand({ t: 'report', playerId: 'p1', reason: 'harassment', text: 'free' })).toEqual({ t: 'report', playerId: 'p1', reason: 'harassment' });
    for (const t of ['like', 'unlike', 'enter'] as const) expect(parseSceneCommand({ t, buildingId: 'b1' })).toEqual({ t, buildingId: 'b1' });
    for (const t of ['block', 'unblock'] as const) expect(parseSceneCommand({ t, playerId: 'p1' })).toEqual({ t, playerId: 'p1' });
    expect(parseSceneCommand({ t: 'leave' })).toEqual({ t: 'leave' });
    const bad = [
      { t: 'hello', v: 1, token: 'x' },
      { t: 'uplink', uplink: {} },
      { t: 'ping' },
      { t: 'pong' },
      { t: 'move', x: Number.NaN, y: 0, dir: 'n', moving: true },
      { t: 'move', x: 2e6, y: 0, dir: 'n', moving: true },
      { t: 'move', x: 0, y: 0, dir: 'up', moving: true },
      { t: 'move', x: 0, y: 0, dir: 'n' },
      { t: 'greet', playerId: 'p1', greetingId: 'free text' },
      { t: 'report', playerId: 'p1', reason: 'anger' },
      { t: 'profile', playerId: '' },
      { t: 'profile', playerId: 'with space' },
      { t: 'resync', chunk: 'x'.repeat(65) },
      { t: 'resync', building: '' },
      { t: 'resync', building: 7 },
      { t: 'enter', buildingId: 'with space' },
      { t: 'enter' },
      null,
      [],
      'move',
    ];
    for (const b of bad) expect(parseSceneCommand(b), JSON.stringify(b)).toBeNull();
  });

  it('within a batch, only the latest move is kept, in place', () => {
    const m = (x: number) => ({ t: 'move' as const, x, y: 0, dir: 'e' as const, moving: true });
    expect(reduceSceneBatch([m(1), { t: 'like', buildingId: 'b' }, m(2), { t: 'profile', playerId: 'p' }, m(3)])).toEqual([
      { t: 'like', buildingId: 'b' },
      { t: 'profile', playerId: 'p' },
      m(3),
    ]);
    expect(reduceSceneBatch([m(1), { t: 'view' }])).toEqual([m(1), { t: 'view' }]);
  });
});

describe('SceneState: inside a building (Phase 4)', () => {
  const ID = 'o_7a8b9c0d1e2f';
  const inside = () => {
    const f = fresh();
    f.s.apply({ t: 'pos', x: 21, y: 15 });
    f.s.apply({ t: 'area', chunk: 'centro:0,0', rev: 2, buildings: [building('b1')] });
    expect(f.s.apply({ t: 'building', rev: 5, detail: sampleBuildingDetail() })).toEqual({ forward: true });
    return f;
  };

  it('building: full interior and rev; a new building replaces everything, even with lower rev', () => {
    const { s } = inside();
    expect(s.inside).toMatchObject({ id: ID, rev: 5, detail: { visitors: 1, building: { owner: { name: 'Helena' } } } });
    expect(s.inside?.detail.floors.map((f) => f.label)).toEqual(['ipe', 'jade', 'aurora']);
    expect(s.apply({ t: 'building', rev: 1, detail: sampleBuildingDetail('away') }).forward).toBe(true);
    expect(s.inside).toMatchObject({ rev: 1, detail: { building: { state: 'away' } } });
    expect(s.inside?.detail.floors.every((f) => f.agents.length === 0)).toBe(true);
  });

  it('building.patch: rev + 1 only; floors, building, and visitors replace; duplicate or stale ignored', () => {
    const { s } = inside();
    const floors = sampleBuildingDetail().floors.slice(0, 1);
    expect(s.apply({ t: 'building.patch', rev: 6, floors })).toEqual({ forward: true });
    expect(s.inside?.detail.floors.map((f) => f.id)).toEqual(['f_0a1b2c3d4e']);
    expect(s.apply({ t: 'building.patch', rev: 7, visitors: 4 })).toEqual({ forward: true });
    expect(s.inside?.detail.visitors).toBe(4);
    expect(s.apply({ t: 'building.patch', rev: 8, building: sampleBuildingDetail('discreet').building })).toEqual({ forward: true });
    expect(s.inside?.detail.building.discreet).toBe(true);
    expect(s.apply({ t: 'building.patch', rev: 8, visitors: 9 })).toEqual({ forward: false });
    expect(s.apply({ t: 'building.patch', rev: 3, visitors: 9 })).toEqual({ forward: false });
    expect(s.inside?.detail.visitors).toBe(4);
    // `building` of another building in patch: not for this interior
    expect(s.apply({ t: 'building.patch', rev: 9, building: { ...sampleBuildingDetail().building, id: 'outro' } })).toEqual({ forward: false });
    expect(s.inside?.rev).toBe(8);
  });

  it('rev gap in building: requests resync {building} (at most once every 5 s) and does not forward; next building resolves', () => {
    const { s, now } = inside();
    expect(s.apply({ t: 'building.patch', rev: 8, visitors: 2 })).toEqual({ forward: false, resyncBuilding: ID });
    expect(s.apply({ t: 'building.patch', rev: 9, visitors: 2 })).toEqual({ forward: false });
    now.t += RESYNC_GAP_MS;
    expect(s.apply({ t: 'building.patch', rev: 9, visitors: 2 })).toEqual({ forward: false, resyncBuilding: ID });
    expect(s.inside?.detail.visitors).toBe(1);
    expect(s.apply({ t: 'building', rev: 9, detail: sampleBuildingDetail() }).forward).toBe(true);
    expect(s.apply({ t: 'building.patch', rev: 10, visitors: 3 })).toEqual({ forward: true });
    // After building, a new gap requests immediately.
    expect(s.apply({ t: 'building.patch', rev: 12 }).resyncBuilding).toBe(ID);
  });

  it('like.update for current building (indoor like, Phase 5) also updates interior', () => {
    const { s } = inside();
    expect(s.apply({ t: 'like.update', buildingId: ID, likes: 99, likedByMe: true })).toEqual({ forward: true });
    expect(s.inside?.detail.building).toMatchObject({ likes: 99, likedByMe: true });
    expect(s.apply({ t: 'like.update', buildingId: 'outro', likes: 7, likedByMe: true }).forward).toBe(true);
    expect(s.inside?.detail.building.likes).toBe(99);
  });

  it('outside a building, building.patch does not pass (or request anything)', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'building.patch', rev: 2, visitors: 1 })).toEqual({ forward: false });
  });

  it('inside, pos is return to street: interior cleared; clear also resets', () => {
    const { s } = inside();
    expect(s.apply({ t: 'pos', x: 22, y: 16 }).forward).toBe(true);
    expect(s.inside).toBeUndefined();
    expect(s.pos).toMatchObject({ x: 22, y: 16 });
    expect(s.apply({ t: 'building.patch', rev: 6, visitors: 1 })).toEqual({ forward: false });
    const again = inside().s;
    again.clear();
    expect(again.inside).toBeUndefined();
  });

  it('snapshot includes interior (new stream during visit stays inside), as copy', () => {
    const { s } = inside();
    const snap = { stream: 'x', connected: true, viewing: true, ...s.snapshot() };
    expect(snap.inside).toMatchObject({ id: ID, rev: 5 });
    const copy = SceneState.fromSnapshot(snap);
    expect(copy.apply({ t: 'building.patch', rev: 6, visitors: 7 }).forward).toBe(true);
    expect(copy.inside?.detail.visitors).toBe(7);
    expect(s.inside?.detail.visitors).toBe(1);
    expect(fresh().s.snapshot()).not.toHaveProperty('inside');
  });
});

describe('lightweight social (Phase 5)', () => {
  it('new commands reconstructed field by field: stamp from list, code format only, knock, summary seen', () => {
    expect(parseSceneCommand({ t: 'stamp', buildingId: 'b1', stampId: 'rocket', x: 1 })).toEqual({ t: 'stamp', buildingId: 'b1', stampId: 'rocket' });
    expect(parseSceneCommand({ t: 'teleport' })).toEqual({ t: 'teleport' });
    expect(parseSceneCommand({ t: 'teleport', code: 'hb-4f2k' })).toEqual({ t: 'teleport', code: 'hb-4f2k' });
    expect(parseSceneCommand({ t: 'knock', buildingId: 'b1' })).toEqual({ t: 'knock', buildingId: 'b1' });
    expect(parseSceneCommand({ t: 'summary.seen', since: 'x' })).toEqual({ t: 'summary.seen' });
    for (const b of [
      { t: 'stamp', buildingId: 'b1', stampId: 'free text' },
      { t: 'stamp', stampId: 'star' },
      { t: 'teleport', code: 'HB-4F2K-WAY-TOO-LONG' },
      { t: 'teleport', code: '<script>' },
      { t: 'teleport', code: 7 },
      { t: 'knock', buildingId: '' },
    ]) expect(parseSceneCommand(b), JSON.stringify(b)).toBeNull();
  });

  it('city is stored and included in snapshot (field by field); fireworks pass; malformed does not', () => {
    const { s } = fresh();
    const city = { t: 'city', lit: 42, goal: { id: '2026-10-12:agent_hours_10k', label: 'agent_hours_10k', target: 10000, progress: 8000, until: 1 }, tokensBand: 4, extra: 'x' };
    expect(s.apply(city)).toEqual({ forward: true });
    expect(s.snapshot().city).toEqual({ lit: 42, goal: { id: '2026-10-12:agent_hours_10k', label: 'agent_hours_10k', target: 10000, progress: 8000, until: 1 }, tokensBand: 4 });
    // unknown goal id or band outside 0..5: only valid fields kept
    expect(s.apply({ t: 'city', lit: 3, goal: { id: 'x', label: 'agent_hours_1', target: 1, progress: 0, until: 0 }, tokensBand: 9 })).toEqual({ forward: true });
    expect(s.city).toEqual({ lit: 3 });
    expect(s.apply({ t: 'city', lit: -1 }).forward).toBe(false);
    expect(s.apply({ t: 'city.fireworks', goalId: '2026-10-12:agent_hours_10k' }).forward).toBe(true);
    expect(s.apply({ t: 'city.fireworks' }).forward).toBe(false);
    // on clearing city, city is reset: server sends fresh one on reopen
    s.clear();
    expect(s.snapshot().city).toBeUndefined();
  });

  it('daily likes and summary: kept until next connection; summary.seen clears summary; knock passes', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'likes.today', count: 3 })).toEqual({ forward: true });
    expect(s.apply({ t: 'likes.today', count: -2 }).forward).toBe(false);
    const sum = { t: 'away.summary', since: '2026-10-14', visits: 5, likes: 12, stamps: [{ stampId: 'star', count: 2 }, { stampId: 'xx', count: 1 }, { stampId: 'star', count: 9 }] };
    expect(s.apply(sum)).toEqual({ forward: true });
    expect(s.snapshot()).toMatchObject({ likesToday: 3, summary: { since: '2026-10-14', visits: 5, likes: 12, stamps: [{ stampId: 'star', count: 2 }] } });
    expect(s.apply({ t: 'away.summary', since: 'yesterday', visits: 1, likes: 0, stamps: [] }).forward).toBe(false);
    expect(s.apply({ t: 'knock' })).toEqual({ forward: true });
    s.clear();
    expect(s.likesToday).toBe(3);
    s.noteCommand({ t: 'summary.seen' });
    expect(s.summary).toBeUndefined();
    s.apply({ t: 'away.summary', since: '2026-10-14', visits: 1, likes: 0, stamps: [] });
    s.welcome(WELCOME);
    expect(s.likesToday).toBeUndefined();
    expect(s.summary).toBeUndefined();
  });

  it('liking, greeting, stamping, knocking, and teleporting clear afk', () => {
    const { s } = fresh();
    for (const cmd of [{ t: 'like', buildingId: 'b' }, { t: 'greet', playerId: 'p', greetingId: 'wave' }, { t: 'stamp', buildingId: 'b', stampId: 'star' }, { t: 'knock', buildingId: 'b' }, { t: 'teleport' }] as const) {
      s.apply({ t: 'afk' });
      s.noteCommand(cmd);
      expect(s.afk, cmd.t).toBe(false);
    }
  });
});
