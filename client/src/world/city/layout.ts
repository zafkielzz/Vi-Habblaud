// Habblaud World city: geometry from shared/world/city.ts adapted for scene needs (pure, no DOM).
//
// - Block cell: block, surrounding sidewalk, and street to east and south (51 × 33 tiles, distance
//   between two blocks). All cells are identical (except plaza); cell ground is drawn once and
//   repeated (rendered in scene.ts).
// - Walkable grid for A* in a tile window with offset origin (city extends into negatives).
// - Deterministic decoration via block and lot seed: lamp posts and trees on sidewalk, benches, gardens in
//   empty lots, building backyards, and plaza (fountain, benches, totem).
//
// Units: TILES in protocol positions (x east, y south; point is at feet); world px = tiles × TILE.
import { TILE } from '../../art/api';
import { hash32, mulberry32 } from '../../../../shared/hash';
import {
  BLOCK,
  BLOCK_STRIDE,
  BLOCK_TILES,
  DOOR,
  FOUNTAIN,
  LOT,
  SIDEWALK,
  SPAWN,
  STREET,
  blockAt,
  blockOrigin,
  isPlaza,
  isWalkable,
  lotDoor,
  lotOrigin,
  type CityPoint,
} from '../../../../shared/world/city';
import { BLOCKED, FREE, WalkGrid } from '../path/grid';

export { TILE };

/** Rectangle in tiles. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Block cell relative to block origin, in tiles: starts at west/north sidewalk and includes east/south street. */
export const CELL: TileRect = { x: -SIDEWALK, y: -SIDEWALK, w: BLOCK_STRIDE.x, h: BLOCK_STRIDE.y };

/** Building width (tiles) within lot: 1 free tile on each side (hedge-lined alley). */
export const BUILDING_TILES = LOT.w - 2;

export const lotKey = (lot: CityPoint): string => `${lot.x},${lot.y}`;
export const blockKey = (b: CityPoint): string => `${b.x},${b.y}`;

/** Visual seed of a block (lamp posts, trees, benches). */
export function blockSeed(b: CityPoint): number {
  return hash32(`quarteirao:${b.x},${b.y}`);
}

/** Visual seed of a lot (facade, garden). Same regardless of who occupies the lot. */
export function lotSeed(lot: CityPoint): number {
  return hash32(`lote:${lot.x},${lot.y}`);
}

/** Is lot in top row of block (door facing north)? */
export function isNorthRow(lot: CityPoint): boolean {
  return lot.y - BLOCK.h * Math.floor(lot.y / BLOCK.h) === 0;
}

/** The 6 lots in a block, in row-major order (empty in plaza). */
export function lotsOfBlock(b: CityPoint): CityPoint[] {
  if (isPlaza(b)) return [];
  const out: CityPoint[] = [];
  for (let j = 0; j < BLOCK.h; j++) for (let i = 0; i < BLOCK.w; i++) out.push({ x: b.x * BLOCK.w + i, y: b.y * BLOCK.h + j });
  return out;
}

/** Rectangle (px) of a cell. */
export function cellPx(b: CityPoint): { x: number; y: number; w: number; h: number } {
  const o = blockOrigin(b);
  return { x: (o.x + CELL.x) * TILE, y: (o.y + CELL.y) * TILE, w: CELL.w * TILE, h: CELL.h * TILE };
}

/** Blocks whose cells intersect rectangle (px), with margin (px) for elements extending above base. */
export function blockRange(view: { x0: number; y0: number; x1: number; y1: number }, margin = 4 * TILE): { bx0: number; by0: number; bx1: number; by1: number } {
  const sw = BLOCK_STRIDE.x * TILE;
  const sh = BLOCK_STRIDE.y * TILE;
  const ox = CELL.x * TILE;
  const oy = CELL.y * TILE;
  return {
    bx0: Math.floor((view.x0 - margin - ox) / sw),
    by0: Math.floor((view.y0 - margin - oy) / sh),
    bx1: Math.floor((view.x1 + margin - ox) / sw),
    by1: Math.floor((view.y1 + margin - oy) / sh),
  };
}

// ------------------------------------------------------------------ cell surfaces (ground)

export interface Crosswalk {
  /** Rectangle in tiles relative to cell; `across` = crossing direction ('ns' crosses an east-west street). */
  rect: TileRect;
  across: 'ns' | 'we';
}

export interface CellSurfaces {
  /** Sidewalk ring (outer rectangle and inner block), relative to cell. */
  sidewalkOuter: TileRect;
  block: TileRect;
  /** Roadways: vertical (east), horizontal (south), and intersection. */
  streets: TileRect[];
  intersection: TileRect;
  crosswalks: Crosswalk[];
  /** Dashed center stripe: segments [x0, y0, x1, y1] in tiles (relative to cell). */
  laneMarks: [number, number, number, number][];
  /** Lots (row-major order) relative to cell. */
  lots: TileRect[];
}

/** Contents of each cell, in tiles relative to northwest cell corner (all identical). */
export function cellSurfaces(): CellSurfaces {
  const S = SIDEWALK;
  const bw = BLOCK_TILES.w;
  const bh = BLOCK_TILES.h;
  const ow = bw + 2 * S;
  const oh = bh + 2 * S;
  const lots: TileRect[] = [];
  for (let j = 0; j < BLOCK.h; j++) for (let i = 0; i < BLOCK.w; i++) lots.push({ x: S + i * LOT.w, y: S + j * LOT.h, w: LOT.w, h: LOT.h });
  const mid = STREET / 2;
  return {
    sidewalkOuter: { x: 0, y: 0, w: ow, h: oh },
    block: { x: S, y: S, w: bw, h: bh },
    streets: [
      { x: ow, y: 0, w: STREET, h: oh },
      { x: 0, y: oh, w: ow, h: STREET },
    ],
    intersection: { x: ow, y: oh, w: STREET, h: STREET },
    crosswalks: [
      // crossing bottom street (east-west), at both corners of the block
      { rect: { x: 0, y: oh, w: S, h: STREET }, across: 'ns' },
      { rect: { x: ow - S, y: oh, w: S, h: STREET }, across: 'ns' },
      // crossing right street (north-south)
      { rect: { x: ow, y: 0, w: STREET, h: S }, across: 'we' },
      { rect: { x: ow, y: oh - S, w: STREET, h: S }, across: 'we' },
    ],
    laneMarks: [
      [S + 1, oh + mid, ow - S - 1, oh + mid],
      [ow + mid, S + 1, ow + mid, oh - S - 1],
    ],
    lots,
  };
}

// ------------------------------------------------------------------ walkable grid (A*)

/** Walkable grid of a tile window: local `grid`, (ox, oy) = tile of cell (0, 0). */
export interface WalkWindow {
  grid: WalkGrid;
  ox: number;
  oy: number;
}

/** Every lot blocks (with or without building), matching server. */
const anyLot = (): boolean => true;

/** Grid of a window (tiles, integers): free where `isWalkable` from city.ts allows walking. */
export function buildWalkGrid(rect: TileRect): WalkWindow {
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  const w = Math.max(1, Math.ceil(rect.w));
  const h = Math.max(1, Math.ceil(rect.h));
  const grid = new WalkGrid(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid.cells[y * w + x] = isWalkable(x0 + x + 0.5, y0 + y + 0.5, anyLot) ? FREE : BLOCKED;
  return { grid, ox: x0, oy: y0 };
}

/** Grid window covering path from `a` to `b` (tiles) with margin: one block on each side. */
export function walkRectFor(a: CityPoint, b: CityPoint, margin = Math.max(BLOCK_STRIDE.x, BLOCK_STRIDE.y)): TileRect {
  const x0 = Math.floor(Math.min(a.x, b.x)) - margin;
  const y0 = Math.floor(Math.min(a.y, b.y)) - margin;
  const x1 = Math.ceil(Math.max(a.x, b.x)) + margin;
  const y1 = Math.ceil(Math.max(a.y, b.y)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Nearest walkable tile to (x, y) (tiles), searching in concentric rings up to `maxR`. */
export function nearestWalkableTile(x: number, y: number, maxR = 16): CityPoint | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (isWalkable(tx + 0.5, ty + 0.5, anyLot)) return { x: tx, y: ty };
  for (let r = 1; r <= maxR; r++) {
    let best: CityPoint | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!isWalkable(tx + dx + 0.5, ty + dy + 0.5, anyLot)) continue;
        const d = (tx + dx + 0.5 - x) ** 2 + (ty + dy + 0.5 - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: tx + dx, y: ty + dy };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Is (x, y) walkable in tiles? (same check as server). */
export function walkable(x: number, y: number): boolean {
  return isWalkable(x, y, anyLot);
}

// ------------------------------------------------------------------ doors

export interface DoorInfo {
  lot: CityPoint;
  side: 'n' | 's';
  /** Sidewalk point in front of door (tiles). */
  front: CityPoint;
}

/** Nearest door to (x, y) within `maxDist` tiles, among lots accepted by `has` (e.g. only built ones). */
export function nearestDoor(x: number, y: number, has: (lot: CityPoint) => boolean, maxDist = 1.6): DoorInfo | null {
  const { x: bx, y: by } = blockAt(x, y);
  let best: DoorInfo | null = null;
  let bestD = maxDist * maxDist;
  for (let j = by - 1; j <= by + 1; j++) {
    for (let i = bx - 1; i <= bx + 1; i++) {
      for (const lot of lotsOfBlock({ x: i, y: j })) {
        const d = lotDoor(lot);
        const dd = (d.front.x - x) ** 2 + (d.front.y - y) ** 2;
        if (dd <= bestD && has(lot)) {
          bestD = dd;
          best = { lot, side: d.side, front: d.front };
        }
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ decoration

export type DecorKind = 'tree' | 'pine' | 'bush' | 'flowers' | 'lamp' | 'bench' | 'rock' | 'hedge' | 'parasol' | 'totem' | 'fountain' | 'planter';

export interface Decor {
  kind: DecorKind;
  /** world px: bottom center point (base); determines depth sorting. */
  x: number;
  y: number;
  seed: number;
  /** Bench: sitting position (tiles, feet point) and facing direction. */
  seat?: { x: number; y: number; dir: 'down' | 'up' | 'left' | 'right' };
  /** Small detail (hidden at far zoom). */
  small?: boolean;
}

/** Clearance (tiles) from a door where sidewalk remains clear of trees and lamp posts. */
const DOOR_CLEAR = 3;

/** Deterministic sidewalk decoration for a block (lamp posts, tree pits, benches). */
export function sidewalkDecor(b: CityPoint): Decor[] {
  const o = blockOrigin(b);
  const seed = blockSeed(b);
  const rng = mulberry32(seed);
  const out: Decor[] = [];
  const px = (t: number) => t * TILE;
  const flip = seed & 1;
  // north and south sidewalks: lamp posts and trees on lot boundaries (away from doors), along curb
  const doorsX = [0, 1, 2].map((i) => o.x + i * LOT.w + DOOR.dx + DOOR.w / 2);
  const nearDoor = (x: number) => doorsX.some((d) => Math.abs(x - d) < DOOR_CLEAR);
  for (const side of ['n', 's'] as const) {
    const rowY = side === 'n' ? o.y - SIDEWALK : o.y + BLOCK_TILES.h + SIDEWALK - 1;
    const slots = [0, LOT.w, 2 * LOT.w, 3 * LOT.w];
    slots.forEach((sx, i) => {
      const tx = o.x + sx;
      if (nearDoor(tx)) return;
      const lamp = (i + flip + (side === 's' ? 1 : 0)) % 2 === 0;
      if (lamp) out.push({ kind: 'lamp', x: px(tx) + (sx === 0 ? 6 : sx === 3 * LOT.w ? -6 : 0), y: px(rowY) + 10, seed: seed + i });
      else out.push({ kind: rng() < 0.22 ? 'pine' : 'tree', x: px(tx), y: px(rowY) + 12, seed: Math.floor(rng() * 1e9) });
    });
    // one bench per side, facing the street (north: back to the block)
    if (rng() < 0.7) {
      const lot = Math.floor(rng() * 3);
      const bx = o.x + lot * LOT.w + (rng() < 0.5 ? 2 : LOT.w - 3);
      if (!nearDoor(bx + 1)) {
        const by = rowY;
        out.push({ kind: 'bench', x: px(bx + 1), y: px(by) + 13, seed: seed + 7, seat: { x: bx + 1, y: by + 0.85, dir: 'down' } });
      }
    }
  }
  // west and east sidewalks: one lamp post in middle and trees near corners
  for (const side of ['w', 'e'] as const) {
    const colX = side === 'w' ? o.x - SIDEWALK : o.x + BLOCK_TILES.w + SIDEWALK - 1;
    const ys = [3, Math.floor(BLOCK_TILES.h / 2), BLOCK_TILES.h - 3];
    ys.forEach((sy, i) => {
      const ty = o.y + sy;
      const cx = px(colX) + 8;
      if (i === 1) out.push({ kind: 'lamp', x: cx, y: px(ty) + 10, seed: seed + 20 + i });
      else if (rng() < 0.85) out.push({ kind: rng() < 0.25 ? 'pine' : 'tree', x: cx, y: px(ty) + 12, seed: Math.floor(rng() * 1e9) });
      else out.push({ kind: 'bush', x: cx, y: px(ty) + 12, seed: Math.floor(rng() * 1e9), small: true });
    });
  }
  return out;
}

/** Garden variants for empty lots. */
export type GardenKind = 'park' | 'pond' | 'orchard' | 'cafe';
export const GARDEN_KINDS: readonly GardenKind[] = ['park', 'pond', 'orchard', 'cafe'];

export function gardenKind(lot: CityPoint): GardenKind {
  return GARDEN_KINDS[lotSeed(lot) % GARDEN_KINDS.length]!;
}

/**
 * Decoration of a lot. Empty: garden (trees, flowerbeds, benches, parasols). Built: middle-of-block
 * backyard (hedge and bushes behind building), occluded by the building itself when tall.
 */
export function lotDecor(lot: CityPoint, built: boolean): Decor[] {
  const o = lotOrigin(lot);
  const seed = lotSeed(lot);
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const out: Decor[] = [];
  const X = (t: number) => (o.x + t) * TILE;
  const Y = (t: number) => (o.y + t) * TILE;
  const s = () => Math.floor(rng() * 1e9);
  const north = isNorthRow(lot);
  if (built) {
    // backyard: hedge row along middle of block and small bush or tree
    const hy = north ? Y(LOT.h) - 2 : Y(0) + 12;
    for (let x = 1; x < LOT.w - 1; x += 2) out.push({ kind: 'hedge', x: X(x) + TILE, y: hy, seed: seed + x, small: true });
    const ty = north ? Y(LOT.h - 1.4) : Y(1.6);
    if (rng() < 0.8) out.push({ kind: rng() < 0.3 ? 'pine' : 'tree', x: X(1.2), y: ty, seed: s() });
    if (rng() < 0.8) out.push({ kind: rng() < 0.3 ? 'pine' : 'tree', x: X(LOT.w - 1.2), y: ty, seed: s() });
    return out;
  }
  // empty lot: garden. Hedge borders facing sidewalk, with gate where door would be.
  const kind = gardenKind(lot);
  const edgeY = north ? Y(0) + 13 : Y(LOT.h) - 2;
  for (let x = 0; x < LOT.w; x += 2) {
    if (x >= DOOR.dx - 1 && x <= DOOR.dx + 1) continue;
    out.push({ kind: (x / 2) % 3 === 1 ? 'flowers' : 'hedge', x: X(x) + TILE, y: edgeY, seed: seed + x * 3, small: true });
  }
  const cx = LOT.w / 2;
  const cy = LOT.h / 2;
  switch (kind) {
    case 'park':
      out.push({ kind: 'tree', x: X(2.5), y: Y(north ? 4.5 : 3.5), seed: s() });
      out.push({ kind: rng() < 0.5 ? 'pine' : 'tree', x: X(11.5), y: Y(north ? 3.8 : 4.2), seed: s() });
      out.push({ kind: 'tree', x: X(10.5), y: Y(north ? 9.5 : 8.8), seed: s() });
      out.push({ kind: 'bush', x: X(3.5), y: Y(north ? 9.2 : 8.4), seed: s(), small: true });
      out.push({ kind: 'flowers', x: X(cx), y: Y(cy + 0.6), seed: s(), small: true });
      out.push({ kind: 'bench', x: X(cx), y: Y(cy - 1.2), seed: s(), seat: { x: o.x + cx, y: o.y + cy - 1.35, dir: 'down' } });
      break;
    case 'pond':
      out.push({ kind: 'rock', x: X(3.2), y: Y(cy + 2.2), seed: s(), small: true });
      out.push({ kind: 'rock', x: X(10.4), y: Y(cy - 1.8), seed: s(), small: true });
      out.push({ kind: 'tree', x: X(1.8), y: Y(north ? 10.6 : 3.2), seed: s() });
      out.push({ kind: 'pine', x: X(12.2), y: Y(north ? 10.2 : 3.6), seed: s() });
      out.push({ kind: 'bush', x: X(4.6), y: Y(cy - 2.6), seed: s(), small: true });
      out.push({ kind: 'bush', x: X(9.5), y: Y(cy + 2.8), seed: s(), small: true });
      break;
    case 'orchard':
      for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) out.push({ kind: 'tree', x: X(2.2 + i * 3.2), y: Y((north ? 4.6 : 3.6) + j * 4.4), seed: s() });
      break;
    case 'cafe':
      out.push({ kind: 'parasol', x: X(4), y: Y(cy + 0.5), seed: s() });
      out.push({ kind: 'parasol', x: X(10), y: Y(cy + 0.5), seed: s() });
      out.push({ kind: 'planter', x: X(cx), y: Y(cy - 2.5), seed: s(), small: true });
      out.push({ kind: 'tree', x: X(1.6), y: Y(north ? 10.4 : 2.6), seed: s() });
      out.push({ kind: 'tree', x: X(12.4), y: Y(north ? 10.4 : 2.6), seed: s() });
      break;
  }
  return out;
}

/** Plaza (block 0,0): central fountain, benches facing it, tree beds, lamp posts, and totem. */
export function plazaDecor(): Decor[] {
  const o = blockOrigin({ x: 0, y: 0 });
  const X = (t: number) => (o.x + t) * TILE;
  const Y = (t: number) => (o.y + t) * TILE;
  const out: Decor[] = [];
  const f = FOUNTAIN;
  out.push({ kind: 'fountain', x: X(f.x + f.w / 2), y: Y(f.y + f.h), seed: 1 });
  // benches around fountain: two to north (back to north, facing fountain) and two to south
  for (const dx of [-5, 5]) {
    out.push({ kind: 'bench', x: X(f.x + f.w / 2 + dx), y: Y(f.y - 1) + 13, seed: 3 + dx, seat: { x: o.x + f.x + f.w / 2 + dx, y: o.y + f.y - 1 + 0.85, dir: 'down' } });
    out.push({ kind: 'bench', x: X(f.x + f.w / 2 + dx), y: Y(f.y + f.h + 2) + 13, seed: 4 + dx, seat: { x: o.x + f.x + f.w / 2 + dx, y: o.y + f.y + f.h + 2 + 0.85, dir: 'down' } });
  }
  // corner flowerbeds (trees and flowers) and diagonal lamp posts
  const corners: [number, number][] = [
    [6, 5],
    [BLOCK_TILES.w - 6, 5],
    [6, BLOCK_TILES.h - 4],
    [BLOCK_TILES.w - 6, BLOCK_TILES.h - 4],
  ];
  corners.forEach(([cx, cy], i) => {
    out.push({ kind: i % 2 ? 'pine' : 'tree', x: X(cx - 1.5), y: Y(cy), seed: 100 + i * 7 });
    out.push({ kind: 'tree', x: X(cx + 1.5), y: Y(cy + 0.4), seed: 200 + i * 11 });
    out.push({ kind: 'flowers', x: X(cx), y: Y(cy + 1.6), seed: 300 + i, small: true });
    out.push({ kind: 'bush', x: X(cx - 3), y: Y(cy + 1.4), seed: 400 + i, small: true });
    out.push({ kind: 'bush', x: X(cx + 3), y: Y(cy + 1.2), seed: 500 + i, small: true });
  });
  for (const [lx, ly] of [
    [12, 4],
    [BLOCK_TILES.w - 12, 4],
    [12, BLOCK_TILES.h - 5],
    [BLOCK_TILES.w - 12, BLOCK_TILES.h - 5],
  ] as const) {
    out.push({ kind: 'lamp', x: X(lx) + 8, y: Y(ly) + 10, seed: lx * 3 + ly });
  }
  // Habblaud totem beside spawn point
  out.push({ kind: 'totem', x: X(SPAWN.x - 3) + 8, y: Y(SPAWN.y) + 4, seed: 2 });
  out.push({ kind: 'planter', x: X(SPAWN.x + 3) + 8, y: Y(SPAWN.y) + 6, seed: 9, small: true });
  return out;
}

/** Fixed block decoration: sidewalk and, in the plaza, the plaza itself. */
export function blockDecor(b: CityPoint): Decor[] {
  const out = sidewalkDecor(b);
  if (isPlaza(b)) out.push(...plazaDecor());
  return out;
}
