// City geometry (shared/world/city.ts, the source; the world server keeps an exact copy in protocol/city.ts).
// The vectors here match the test there: if either side changes calculations, the other breaks. That the file imports
// nothing (so it can be copied verbatim) is verified in server/world/sources.test.ts, which can read disk.
import { describe, expect, it } from 'vitest';
import {
  BLOCK_STRIDE, BLOCK_TILES, FOUNTAIN, blockAt, blockOf, blockOrigin, blockSpiral, blocksOfChunk, chunkId, chunkOf,
  chunksAround, cityVersion, isWalkable, lotAt, lotDoor, lotOrigin, lotSpiral, parseChunkId, spawnPoint, type CityPoint,
} from './city';

const take = <T>(gen: Iterable<T>, n: number): T[] => {
  const out: T[] = [];
  for (const x of gen) {
    if (out.length === n) break;
    out.push(x);
  }
  return out;
};
const none = () => false;
const all = () => true;

describe('city.ts: constants', () => {
  it('lot 14×12, block 3×2 lots = 42×24, stride 51×33', () => {
    expect(BLOCK_TILES).toEqual({ w: 42, h: 24 });
    expect(BLOCK_STRIDE).toEqual({ x: 51, y: 33 });
    expect(cityVersion).toBe(1);
  });
});

describe('city.ts: spiral', () => {
  it('blocks: east, south, west, north, with steps 1, 1, 2, 2, 3…', () => {
    expect(take(blockSpiral(), 11)).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 0 },
    ]);
  });

  it('first 12 lots (vector on both sides)', () => {
    expect(take(lotSpiral(), 12).map((l) => `(${l.x},${l.y})`).join(' ')).toBe(
      '(3,0) (4,0) (5,0) (3,1) (4,1) (5,1) (3,2) (4,2) (5,2) (3,3) (4,3) (5,3)',
    );
  });

  it('never places a lot in the plaza or repeats', () => {
    const lots = take(lotSpiral(), 600);
    expect(lots.some((l) => blockOf(l).x === 0 && blockOf(l).y === 0)).toBe(false);
    expect(new Set(lots.map((l) => `${l.x},${l.y}`)).size).toBe(600);
  });
});

describe('city.ts: lot, block, and door', () => {
  it('blockOf floors negatives', () => {
    expect(blockOf({ x: 5, y: 1 })).toEqual({ x: 1, y: 0 });
    expect(blockOf({ x: -1, y: -1 })).toEqual({ x: -1, y: -1 });
    expect(blockOf({ x: -3, y: -2 })).toEqual({ x: -1, y: -1 });
    expect(blockOf({ x: -4, y: -3 })).toEqual({ x: -2, y: -2 });
  });

  it('lot origins in tiles', () => {
    expect(blockOrigin({ x: 1, y: 0 })).toEqual({ x: 51, y: 0 });
    expect(lotOrigin({ x: 3, y: 0 })).toEqual({ x: 51, y: 0 });
    expect(lotOrigin({ x: 4, y: 1 })).toEqual({ x: 65, y: 12 });
    expect(lotOrigin({ x: 5, y: 3 })).toEqual({ x: 79, y: 45 });
    expect(lotOrigin({ x: -1, y: -1 })).toEqual({ x: -23, y: -21 });
  });

  it('top row: north door, opening onto north sidewalk', () => {
    const d = lotDoor({ x: 3, y: 0 });
    expect(d).toEqual({ side: 'n', tiles: [{ x: 57, y: 0 }, { x: 58, y: 0 }], front: { x: 58, y: -1 } });
    expect(isWalkable(d.front.x, d.front.y, all)).toBe(true);
    for (const t of d.tiles) expect(isWalkable(t.x, t.y, all)).toBe(false);
    expect(lotDoor({ x: 4, y: 2 })).toEqual({ side: 'n', tiles: [{ x: 71, y: 33 }, { x: 72, y: 33 }], front: { x: 72, y: 32 } });
  });

  it('bottom row: south door, opening onto south sidewalk', () => {
    const d = lotDoor({ x: 3, y: 1 });
    expect(d).toEqual({ side: 's', tiles: [{ x: 57, y: 23 }, { x: 58, y: 23 }], front: { x: 58, y: 24 } });
    expect(isWalkable(d.front.x, d.front.y, all)).toBe(true);
    for (const t of d.tiles) expect(isWalkable(t.x, t.y, all)).toBe(false);
    expect(lotDoor({ x: -1, y: -1 }).side).toBe('s');
    expect(lotDoor({ x: -1, y: -2 }).side).toBe('n');
  });

  it('front of every door is walkable and lotAt maps back to lot', () => {
    for (const lot of take(lotSpiral(), 300)) {
      const d = lotDoor(lot);
      expect(isWalkable(d.front.x, d.front.y, all)).toBe(true);
      const o = lotOrigin(lot);
      expect(lotAt(o.x + 3.5, o.y + 2.5)).toEqual(lot);
      expect(lotAt(d.tiles[0].x, d.tiles[0].y)).toEqual(lot);
      expect(lotAt(d.front.x, d.front.y)).toBeNull();
    }
    expect(lotAt(21, 15)).toBeNull(); // plaza
  });
});

describe('city.ts: chunks', () => {
  it('2×2 blocks, floor on negatives', () => {
    expect(chunkOf({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(chunkOf({ x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
    expect(chunkOf({ x: 2, y: 1 })).toEqual({ x: 1, y: 0 });
    expect(chunkOf({ x: -1, y: -1 })).toEqual({ x: -1, y: -1 });
    expect(chunkOf({ x: -2, y: -3 })).toEqual({ x: -1, y: -2 });
    expect(chunkOf({ x: -3, y: 0 })).toEqual({ x: -2, y: 0 });
  });

  it('round-trip id serialization', () => {
    expect(chunkId('centro', { x: -1, y: 0 })).toBe('centro:-1,0');
    expect(parseChunkId('centro:-1,0')).toEqual({ district: 'centro', chunk: { x: -1, y: 0 } });
    expect(parseChunkId('centro:1')).toBeNull();
    expect(parseChunkId('centro:1.5,0')).toBeNull();
  });

  it('blocks of a chunk and surrounding 3×3', () => {
    expect(blocksOfChunk({ x: -1, y: -1 })).toEqual([{ x: -2, y: -2 }, { x: -1, y: -2 }, { x: -2, y: -1 }, { x: -1, y: -1 }]);
    for (const b of blocksOfChunk({ x: 3, y: -2 })) expect(chunkOf(b)).toEqual({ x: 3, y: -2 });
    const around = chunksAround({ x: 0, y: 0 });
    expect(around).toHaveLength(9);
    expect(around[0]).toEqual({ x: -1, y: -1 });
    expect(around[8]).toEqual({ x: 1, y: 1 });
  });

  it('blockAt: block plus sidewalk and half street', () => {
    expect(blockAt(21, 15)).toEqual({ x: 0, y: 0 });
    expect(blockAt(46.4, 5)).toEqual({ x: 0, y: 0 });
    expect(blockAt(46.6, 5)).toEqual({ x: 1, y: 0 });
    expect(blockAt(-4.4, -4.4)).toEqual({ x: 0, y: 0 });
    expect(blockAt(-4.6, 5)).toEqual({ x: -1, y: 0 });
    expect(blockAt(5, 28.6)).toEqual({ x: 0, y: 1 });
    // lot is always in its own block
    for (const lot of take(lotSpiral(), 100)) {
      const o = lotOrigin(lot);
      expect(blockAt(o.x, o.y)).toEqual(blockOf(lot));
    }
  });
});

describe('city.ts: walkable', () => {
  const walk = (x: number, y: number, occupied: (l: CityPoint) => boolean = none) => isWalkable(x, y, occupied);

  it('sidewalk and street are walkable', () => {
    expect(walk(42, 5)).toBe(true); // east sidewalk of plaza
    expect(walk(43, 5)).toBe(true);
    expect(walk(46, 5)).toBe(true); // street
    expect(walk(49, 5)).toBe(true); // west sidewalk of block (1, 0)
    expect(walk(50, 5)).toBe(true);
    expect(walk(60, -1)).toBe(true); // north sidewalk
    expect(walk(60, -5)).toBe(true); // street
    expect(walk(46, 28)).toBe(true); // intersection
    expect(walk(-1, -1)).toBe(true);
    expect(walk(-9, 5)).toBe(true); // east sidewalk of block (-1, 0)
  });

  it('lot is not walkable, with or without building', () => {
    expect(walk(51, 0)).toBe(false);
    expect(walk(60, 5)).toBe(false);
    expect(walk(60, 5, all)).toBe(false);
    expect(walk(92, 23)).toBe(false); // last tile of block (1, 0)
    expect(walk(-10, 5)).toBe(false); // block (-1, 0)
    expect(walk(-51, -33)).toBe(false);
  });

  it('entire plaza, except the fountain', () => {
    expect(walk(0, 0)).toBe(true);
    expect(walk(41, 23)).toBe(true);
    for (let x = FOUNTAIN.x; x < FOUNTAIN.x + FOUNTAIN.w; x++) {
      for (let y = FOUNTAIN.y; y < FOUNTAIN.y + FOUNTAIN.h; y++) expect(walk(x + 0.5, y + 0.5)).toBe(false);
    }
    expect(walk(18.9, 10)).toBe(true);
    expect(walk(23, 12)).toBe(true);
    expect(walk(19, 9.9)).toBe(true);
    expect(walk(19, 13)).toBe(true);
    // same relative position in a regular block is a lot
    expect(walk(51 + 19, 10)).toBe(false);
  });

  it('decimals: tile containing position determines walkability', () => {
    expect(walk(57.5, -0.01)).toBe(true);
    expect(walk(57.5, 0)).toBe(false);
    expect(walk(41.99, 30)).toBe(true);
  });

  it('invalid number is not walkable', () => {
    expect(walk(Number.NaN, 0)).toBe(false);
    expect(walk(0, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('spawns in plaza, south of fountain', () => {
    const s = spawnPoint();
    expect(s).toEqual({ x: 21, y: 15 });
    expect(walk(s.x, s.y)).toBe(true);
    expect(spawnPoint()).not.toBe(spawnPoint()); // copy: mutating it does not corrupt
  });
});
