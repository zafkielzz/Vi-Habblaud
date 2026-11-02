// Floors generated in 8x8 tile chunks from WORLD coordinates (pure).
// This way wood planks, marble veins, and concrete mottling continue from one tile to
// another seamlessly, and cache size is bounded by world size (not area shapes).
import { TILE, type FloorKind } from '../api';
import { mix, parseColor, ramp, shade, type RGBA } from '../core/color';
import { PixelBuf } from '../core/pixbuf';

export const CHUNK_TILES = 8;
export const CHUNK_PX = CHUNK_TILES * TILE;

/** Deterministic integer hash of up to 3 coordinates + seed. */
export function h3(a: number, b: number, c = 0, seed = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d) ^ Math.imul(seed | 0, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

function rnd01(a: number, b: number, c = 0, seed = 0): number {
  return h3(a, b, c, seed) / 4294967296;
}

/** Smooth value noise (bilinear) in world coordinates, 0..1. */
function noise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = rnd01(gx, gy, 0, seed);
  const b = rnd01(gx + 1, gy, 0, seed);
  const c = rnd01(gx, gy + 1, 0, seed);
  const d = rnd01(gx + 1, gy + 1, 0, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export interface FloorOpts {
  seed: number;
  tint?: string;
  tint2?: string;
}

/** Generates chunk block (cx, cy) — in chunk units — for a floor kind. */
export function floorChunk(kind: FloorKind, cx: number, cy: number, o: FloorOpts): PixelBuf {
  const b = new PixelBuf(CHUNK_PX, CHUNK_PX);
  const x0 = cx * CHUNK_PX;
  const y0 = cy * CHUNK_PX;
  switch (kind) {
    case 'wood':
      paintWood(b, x0, y0, o.seed);
      break;
    case 'concrete':
      paintConcrete(b, x0, y0, o.seed);
      break;
    case 'marble':
      paintMarble(b, x0, y0, o.seed);
      break;
    case 'sidewalk':
      paintSidewalk(b, x0, y0, o.seed);
      break;
    default:
      for (let ty = 0; ty < CHUNK_TILES; ty++) {
        for (let tx = 0; tx < CHUNK_TILES; tx++) {
          b.ox = tx * TILE;
          b.oy = ty * TILE;
          paintTile(b, kind, cx * CHUNK_TILES + tx, cy * CHUNK_TILES + ty, o);
        }
      }
      b.ox = 0;
      b.oy = 0;
  }
  return b;
}

// ------------------------------------------------------------------ tiled floors

function paintTile(b: PixelBuf, kind: FloorKind, tx: number, ty: number, o: FloorOpts): void {
  const r = (i: number) => rnd01(tx, ty, i, o.seed);
  switch (kind) {
    case 'carpet': {
      // Modular carpet tiles: subtle weave alternating in direction (checkerboard orientation).
      const c1 = o.tint ?? '#c9d1dc';
      const c2 = o.tint2 ?? shade(c1, -0.03);
      const odd = (tx + ty) & 1;
      const base = mix(c1, c2, odd ? 0.55 : 0.15);
      b.rect(0, 0, TILE, TILE, base);
      const weave = shade(base, -0.018);
      for (let a = 1; a < TILE - 1; a += 3) {
        for (let k = 1; k < TILE - 1; k++) {
          if ((k + a) % 4 === 0) continue;
          if (odd) b.set(k, a, weave);
          else b.set(a, k, weave);
        }
      }
      for (let i = 0; i < 3; i++) b.set(Math.floor(r(i) * 14) + 1, Math.floor(r(i + 9) * 14) + 1, shade(base, i % 2 ? 0.03 : -0.035));
      b.hline(0, TILE - 1, TILE - 1, shade(base, -0.06));
      b.vline(TILE - 1, 0, TILE - 1, shade(base, -0.06));
      b.hline(0, TILE - 2, 0, shade(base, 0.025));
      b.vline(0, 0, TILE - 2, shade(base, 0.025));
      break;
    }
    case 'tile_check': {
      const a = '#f2ede4';
      const c = '#d2d8de';
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const col = (qx + qy + tx + ty) % 2 ? c : a;
          b.rect(qx * 8, qy * 8, 8, 8, col);
          b.hline(qx * 8, qx * 8 + 6, qy * 8, shade(col, 0.02));
          b.hline(qx * 8, qx * 8 + 7, qy * 8 + 7, shade(col, -0.045));
          b.vline(qx * 8 + 7, qy * 8, qy * 8 + 7, shade(col, -0.045));
          if (r(qx + qy * 2) < 0.3) b.set(qx * 8 + 2 + Math.floor(r(5) * 4), qy * 8 + 2 + Math.floor(r(6) * 4), shade(col, -0.02));
        }
      }
      break;
    }
    case 'tile_white': {
      const col = '#eef2f5';
      const grout = '#d3dae1';
      b.rect(0, 0, TILE, TILE, col);
      for (let q = 0; q < 2; q++) {
        b.hline(0, TILE - 1, q * 8 + 7, grout);
        b.vline(q * 8 + 7, 0, TILE - 1, grout);
      }
      for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) b.hline(qx * 8, qx * 8 + 2, qy * 8, '#fbfcfd');
      if (r(1) < 0.4) b.set(Math.floor(r(2) * 14), Math.floor(r(3) * 14), '#e4eaef');
      break;
    }
    case 'grass': {
      const g = ramp('#6cab57', 0.045);
      const n = noise(tx * TILE, ty * TILE, 48, o.seed + 5);
      const base = mix(g.dk, g.lt, n);
      b.rect(0, 0, TILE, TILE, base);
      for (let i = 0; i < 12; i++) {
        const x = Math.floor(r(i) * TILE);
        const y = Math.floor(r(i + 20) * TILE);
        const c = r(i + 40) < 0.5 ? shade(base, 0.05) : shade(base, -0.05);
        b.set(x, y, c);
        if (r(i + 60) < 0.5) b.set(x, y - 1, shade(c, 0.03));
      }
      for (let i = 0; i < 2; i++) {
        const x = 2 + Math.floor(r(i + 80) * 12);
        const y = 3 + Math.floor(r(i + 90) * 11);
        b.set(x, y, g.dd);
        b.set(x - 1, y - 1, g.dk);
        b.set(x + 1, y - 1, g.dk);
        b.set(x, y - 2, g.lt);
      }
      if (r(99) < 0.12) {
        const fx = 3 + Math.floor(r(100) * 10);
        const fy = 3 + Math.floor(r(101) * 10);
        const fc = ['#ffffff', '#f7d154', '#f28fb0', '#b9a2f0'][Math.floor(r(102) * 4)];
        b.set(fx, fy, fc);
        b.set(fx + 1, fy, fc);
        b.set(fx, fy - 1, fc);
        b.set(fx + 1, fy + 1, '#f2c14e');
      }
      break;
    }
    case 'street': {
      const n = noise(tx * TILE, ty * TILE, 64, o.seed + 9);
      const col = mix('#4b4f58', '#565a63', n);
      b.rect(0, 0, TILE, TILE, col);
      for (let i = 0; i < 14; i++) b.set(Math.floor(r(i) * TILE), Math.floor(r(i + 30) * TILE), r(i + 60) < 0.5 ? '#5f636c' : '#43464e');
      break;
    }
    default:
      b.rect(0, 0, TILE, TILE, '#dcdedf');
  }
}

// ------------------------------------------------------------------ continuous floors

/** Precalculated RGBA color table for fast writing. */
function rgba(c: string): RGBA {
  return parseColor(c);
}

const WOOD_TONES = ['#c99668', '#c48f61', '#cf9f72', '#c6925f'] as const;
/** [tone][0 normal, 1 top, 2 base, 3 grain, 4 seam, 5 after seam, 6 knot]. */
const WOOD: readonly (readonly RGBA[])[] = WOOD_TONES.map((t) =>
  [t, shade(t, 0.03), shade(t, -0.075), shade(t, -0.03), shade(t, -0.1), shade(t, 0.03), shade(t, -0.12)].map(rgba),
);

/** Wood planks: 4px tall, 48px long, staggered joints, grain, and knots. */
function paintWood(b: PixelBuf, x0: number, y0: number, seed: number): void {
  for (let py = 0; py < CHUNK_PX; py++) {
    const wy = y0 + py;
    const row = Math.floor(wy / 4);
    const iy = wy - row * 4;
    const off = h3(row, 0, 1, seed) % 48;
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px + off;
      const plank = Math.floor(wx / 48);
      const ix = wx - plank * 48;
      const ph = h3(row, plank, 2, seed);
      const t = WOOD[ph % WOOD.length];
      let k = 0;
      if (ix === 0) k = 4;
      else if (iy === 3) k = 2;
      else if (iy === 0) k = ix === 1 ? 5 : 1;
      else if (iy === 2 && ix === 10 + ((ph >>> 12) % 20) && (ph >>> 20) % 5 === 0) k = 6;
      else if (iy === 1 + ((ph >>> 5) % 2) && (ix + (ph >>> 8)) % 23 < 7) k = 3;
      else if (ix === 1) k = 5;
      b.put(px, py, t[k]);
    }
  }
}

const LEVELS = 16;
const CONCRETE: readonly RGBA[] = Array.from({ length: LEVELS }, (_, i) => rgba(mix('#d6d9dc', '#e4e6e8', i / (LEVELS - 1))));
const CONCRETE_EDGE: readonly RGBA[] = CONCRETE.map((c) => rgba(shade(`rgb(${c[0]},${c[1]},${c[2]})`, 0.02)));
const CONCRETE_SEAM = rgba('#c8cdd2');
const CONCRETE_SPECK = [rgba('#cdd1d5'), rgba('#eceeef')] as const;

/** Light polished concrete in 2x2 tile slabs with smooth continuous mottling. */
function paintConcrete(b: PixelBuf, x0: number, y0: number, seed: number): void {
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const sx = wx & 31;
      const sy = wy & 31;
      if (sx === 31 || sy === 31) {
        b.put(px, py, CONCRETE_SEAM);
        continue;
      }
      const sp = h3(wx, wy, 3, seed) % 61;
      if (sp < 2) {
        b.put(px, py, CONCRETE_SPECK[sp]);
        continue;
      }
      const n = noise(wx, wy, 26, seed) * 0.6 + noise(wx, wy, 7, seed + 3) * 0.4;
      const lv = Math.min(LEVELS - 1, Math.floor(n * LEVELS));
      b.put(px, py, sx === 0 || sy === 0 ? CONCRETE_EDGE[lv] : CONCRETE[lv]);
    }
  }
}

const MARBLE: readonly RGBA[] = Array.from({ length: LEVELS }, (_, i) => rgba(mix('#ebe8e3', '#f5f3f0', i / (LEVELS - 1))));
const MARBLE_VEIN = [rgba('#e2e3e6'), rgba('#cfd2d7')] as const;
const MARBLE_SEAM = rgba('#d6d3ce');

/** White marble in 2x2 tile slabs with continuous gray veins within the slab. */
function paintMarble(b: PixelBuf, x0: number, y0: number, seed: number): void {
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      if ((wx & 31) === 31 || (wy & 31) === 31) {
        b.put(px, py, MARBLE_SEAM);
        continue;
      }
      const slab = h3(wx >> 5, wy >> 5, 4, seed);
      const ax = (slab % 1000) / 1000;
      // Only some slabs have veins (one or two smooth continuous lines).
      const veined = (slab >>> 12) % 5 < 2;
      const v = veined ? Math.sin(wx * 0.08 + wy * (0.14 + ax * 0.1) + noise(wx, wy, 14, seed + 12) * 2.4 + ax * 6.28) : 0;
      if (v > 0.997) b.put(px, py, MARBLE_VEIN[1]);
      else if (v > 0.986) b.put(px, py, MARBLE_VEIN[0]);
      else b.put(px, py, MARBLE[Math.min(LEVELS - 1, Math.floor(noise(wx, wy, 20, seed + 11) * LEVELS))]);
    }
  }
}

const WALK_TONES = ['#d3cdc2', '#cfc8bc', '#d8d2c8'] as const;
/** [tone][0 normal, 1 joint, 2 light border, 3 speckle]. */
const WALK: readonly (readonly RGBA[])[] = WALK_TONES.map((t) => [t, '#b8b1a5', shade(t, 0.03), shade(t, -0.05)].map(rgba));

/** Sidewalk of 16x8 slabs in staggered rows. */
function paintSidewalk(b: PixelBuf, x0: number, y0: number, seed: number): void {
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const row = wy >> 3;
      const off = row & 1 ? 8 : 0;
      const ix = (wx + off) & 15;
      const iy = wy & 7;
      const t = WALK[h3((wx + off) >> 4, row, 5, seed) % WALK.length];
      let k = 0;
      if (iy === 7 || ix === 15) k = 1;
      else if (iy === 0 || ix === 0) k = 2;
      else if (h3(wx, wy, 6, seed) % 41 === 0) k = 3;
      b.put(px, py, t[k]);
    }
  }
}
