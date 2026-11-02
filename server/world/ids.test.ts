// World ids (server/world/ids.ts) with fake clock: random, stable for 24 h ± 6 h, rotated automatically, new
// for those that disappear and return, and never derived from the office key.
import { describe, expect, it } from 'vitest';
import { ID_JITTER_MS, ID_LIFETIME_MS, WorldIds } from './ids';

const H = 3_600_000;
const T0 = 1_760_000_000_000;

describe('WorldIds', () => {
  it('contract format: f_ + 10 hex and a_ + 8 hex', () => {
    const ids = new WorldIds();
    expect(ids.floorId('/Users/ana/projeto', T0)).toMatch(/^f_[0-9a-f]{10}$/);
    expect(ids.agentId('.claude:1234', T0)).toMatch(/^a_[0-9a-f]{8}$/);
  });

  it('random, not derived: same key produces different ids in another instance (another process)', () => {
    const a = new WorldIds();
    const b = new WorldIds();
    const keys = Array.from({ length: 20 }, (_, i) => `/p/${i}`);
    const fa = keys.map((k) => a.floorId(k, T0));
    const fb = keys.map((k) => b.floorId(k, T0));
    expect(fa.filter((id, i) => id === fb[i])).toEqual([]);
    expect(new Set(fa).size).toBe(20);
  });

  it('same id while valid; rotates between 18 h and 30 h, each id with its own random draw', () => {
    let j = 0;
    const jitters = [-ID_JITTER_MS, ID_JITTER_MS, 0];
    const ids = new WorldIds({ jitter: () => jitters[j++ % jitters.length] });
    const f1 = ids.floorId('/p/a', T0); // lives 18 h
    const f2 = ids.floorId('/p/b', T0); // lives 30 h
    const a1 = ids.agentId('m1', T0); // lives 24 h
    for (const t of [T0 + H, T0 + 17 * H]) {
      expect(ids.floorId('/p/a', t)).toBe(f1);
      expect(ids.floorId('/p/b', t)).toBe(f2);
      expect(ids.agentId('m1', t)).toBe(a1);
    }
    expect(ids.floorId('/p/a', T0 + 18 * H)).not.toBe(f1);
    expect(ids.floorId('/p/b', T0 + 18 * H)).toBe(f2);
    expect(ids.agentId('m1', T0 + 24 * H - 1)).toBe(a1);
    expect(ids.agentId('m1', T0 + 24 * H)).not.toBe(a1);
    expect(ids.floorId('/p/b', T0 + 30 * H)).not.toBe(f2);
  });

  it('standard random draw stays between 18 h and 30 h', () => {
    const ids = new WorldIds();
    for (let i = 0; i < 50; i++) {
      const key = `/p/${i}`;
      const first = ids.floorId(key, T0);
      expect(ids.floorId(key, T0 + ID_LIFETIME_MS - ID_JITTER_MS - 1)).toBe(first);
      expect(ids.floorId(key, T0 + ID_LIFETIME_MS + ID_JITTER_MS)).not.toBe(first);
    }
  });

  it('those that disappear and return are reborn with new id; memory does not grow', () => {
    const ids = new WorldIds();
    const f = ids.floorId('/p/a', T0);
    const a = ids.agentId('m1', T0);
    ids.agentId('m2', T0);
    ids.sweep();
    // In following projection only /p/a and m2 appear: m1 is forgotten.
    expect(ids.floorId('/p/a', T0 + 1000)).toBe(f);
    ids.agentId('m2', T0 + 1000);
    ids.sweep();
    expect(ids.size).toEqual({ floors: 1, agents: 1 });
    expect(ids.agentId('m1', T0 + 2000)).not.toBe(a);
    ids.sweep();
    ids.sweep();
    expect(ids.size).toEqual({ floors: 0, agents: 0 });
    expect(ids.floorId('/p/a', T0 + 3000)).not.toBe(f);
  });

  it('without repeating id across keys, nor upon rotating', () => {
    let n = 0;
    // "Bad" source: repeats the same value a few times before changing.
    const ids = new WorldIds({ randomBytes: (len) => new Uint8Array(len).fill(Math.floor(n++ / 3)), jitter: () => 0 });
    const a = ids.agentId('m1', T0);
    const b = ids.agentId('m2', T0);
    expect(a).not.toBe(b);
    const c = ids.agentId('m1', T0 + ID_LIFETIME_MS);
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
  });

  it('clear forgets everything', () => {
    const ids = new WorldIds();
    const f = ids.floorId('/p/a', T0);
    ids.clear();
    expect(ids.floorId('/p/a', T0)).not.toBe(f);
  });
});
