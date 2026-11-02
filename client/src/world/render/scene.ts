// Visual representation of areas: static caches (floor, walls, fixed wall items) and
// lists of dynamic furniture/items ready for per-frame rendering.
import { FURNITURE, TILE, type ArtModule, type FurnitureKind, type FurnitureSprites, type Sprite } from '../../art/api';
import { hash32 } from '../../../../shared/hash';
import type { AreaLayout, WallItemPlacement, WallSegment } from '../layout/types';
import type { RoomState } from '../sim/room-state';
import type { WallArtAsset, WorldAssets } from '../assets';
import type { SeasonalTheme } from '../api';
import { decorateSeasonalRug, decorateSeasonalWall, seasonalRugColor, seasonalWallStyle } from './seasonal';

/** Margin above area in walls cache (items that extend above top of face). */
export const WALL_MARGIN = 16;

/** Wall items redrawn every frame (the rest goes into cache). */
const DYNAMIC_WALL: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>(['window', 'clock', 'whiteboard', 'tv', 'elevator', 'light_switch', 'sign', 'mirror']);

export interface FurnVis {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  seed: number;
  /** World anchor (bottom center of footprint + offset). */
  ax: number;
  ay: number;
  order: number;
  areaId: string;
  /** Desk: seat spot whose activity appears on screen. */
  seatSpot?: string;
  /** Sprites per state (resolved on demand). */
  states: (FurnitureSprites | null | undefined)[];
}

export interface WallVis {
  id: string;
  kind: FurnitureKind;
  variant?: string;
  seed: number;
  cx: number;
  baseY: number;
  on: 'face' | 'south';
  order: number;
  areaId: string;
}

export interface AreaVis {
  id: string;
  layout: AreaLayout;
  room?: RoomState;
  px: { x: number; y: number; w: number; h: number };
  floor: HTMLCanvasElement;
  walls: HTMLCanvasElement;
  furniture: FurnVis[];
  wallItems: WallVis[];
  sign?: WallVis;
  version: number;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Furniture sprites with tolerance for art failures (stub, unknown variant...). */
export function furnitureSprites(art: ArtModule, f: { kind: FurnitureKind; variant?: string; seed: number; states: (FurnitureSprites | null | undefined)[] }, state = 0): FurnitureSprites | null {
  const hit = f.states[state];
  if (hit !== undefined) return hit;
  let s: FurnitureSprites | null = null;
  try {
    s = art.furnitureSprites(f.kind, f.variant, state, { seed: f.seed }) ?? null;
    if (s && !s.base?.canvas) s = null;
  } catch {
    s = null;
  }
  f.states[state] = s;
  return s;
}

const opaqueCache = new WeakMap<HTMLCanvasElement, { x: number; y: number; w: number; h: number }>();

/** Opaque pixel bounding box of a canvas (cached per canvas). */
export function opaqueBounds(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const hit = opaqueCache.get(c);
  if (hit) return hit;
  let box = { x: 0, y: 0, w: c.width, h: c.height };
  try {
    const ctx = c.getContext('2d');
    if (ctx && c.width > 0 && c.height > 0) {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width;
      let y0 = c.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 16) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 >= 0) box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  } catch {
    // tainted or unavailable canvas: uses full size
  }
  opaqueCache.set(c, box);
  return box;
}

/** Draw position of a wall item (top-left corner, world px). */
export function wallItemOrigin(w: WallVis, s: Sprite): { x: number; y: number } {
  if (w.on === 'south') {
    // on half-wall: centers opaque content slightly below top of south wall
    const b = opaqueBounds(s.canvas);
    const top = w.baseY - TILE;
    return { x: Math.round(w.cx - (b.x + b.w / 2)), y: Math.round(top + 9 - (b.y + b.h / 2)) };
  }
  return { x: Math.round(w.cx - s.ax), y: Math.round(w.baseY - s.ay) };
}

export function wallSprites(art: ArtModule, kind: FurnitureKind, variant: string | undefined, state: number, seed: number): FurnitureSprites | null {
  try {
    const s = art.furnitureSprites(kind, variant, state, { seed });
    return s && s.base?.canvas ? s : null;
  } catch {
    return null;
  }
}

function drawWallSegment(art: ArtModule, ctx: CanvasRenderingContext2D, w: WallSegment): void {
  try {
    if (w.kind === 'face') art.drawWallFace(ctx, w.x, w.y, w.w, w.style, w.doorways ? { doorways: w.doorways } : undefined);
    else if (w.kind === 'south') art.drawSouthWall(ctx, w.x, w.y, w.w, w.style, w.doorways ? { doorways: w.doorways } : undefined);
    else art.drawWallTop(ctx, w.x, w.y, w.w, w.h, w.style);
  } catch {
    ctx.fillStyle = w.style.base;
    ctx.fillRect(w.x, w.y, w.w, w.kind === 'face' ? 2 * TILE : w.kind === 'south' ? TILE : w.h);
  }
}

/** Top (px above baseboard) of paintings and posters on wall face (just below cap). */
const WALL_ART_TOP = 28;

/**
 * AI-generated art for a painting/poster: fits slot size only (2-tile frames never
 * get wide paintings); posters prefer the same variant as procedural. Pure.
 */
export function pickWallArt(assets: WorldAssets | null, kind: 'painting' | 'poster', tiles: number, variant: string | undefined, seed: number): WallArtAsset | null {
  if (!assets) return null;
  let pool = assets.wallArt.filter((a) => a.kind === kind && a.tiles === tiles);
  if (kind === 'poster' && variant) {
    const same = pool.filter((a) => a.variant === variant);
    if (same.length) pool = same;
  }
  if (!pool.length) return null;
  return pool[(seed >>> 0) % pool.length];
}

/**
 * Draws ready-made art (with its own frame/outline) instead of procedural item, in native
 * size and whole pixels. Returns false if asset has no ready-made version (frameless painting).
 */
function drawWallArtAsset(ctx: CanvasRenderingContext2D, item: WallVis, a: WallArtAsset): boolean {
  const img = a.framed ?? (a.kind === 'poster' ? a : null);
  if (!img) return false;
  const x = Math.round(item.cx - img.w / 2);
  const y = item.baseY - WALL_ART_TOP;
  // soft wall shadow (right and bottom), like procedural items
  ctx.fillStyle = 'rgba(30,34,52,0.16)';
  ctx.fillRect(x + img.w, y + 1, 1, img.h);
  ctx.fillRect(x + 1, y + img.h, img.w, 1);
  ctx.drawImage(img.img, x, y);
  return true;
}

/** Painting without pre-rendered frame: central crop in native size inside procedural frame. */
function drawRawPainting(ctx: CanvasRenderingContext2D, s: Sprite, ox: number, oy: number, a: WallArtAsset): void {
  let r = s.rects?.art;
  if (!r) {
    const b = opaqueBounds(s.canvas);
    r = { x: b.x + 2, y: b.y + 2, w: b.w - 4, h: b.h - 4 };
  }
  if (r.w <= 2 || r.h <= 2) return;
  const sw = Math.min(a.w, r.w);
  const sh = Math.min(a.h, r.h);
  const sx = Math.floor((a.w - sw) / 2);
  const sy = Math.floor((a.h - sh) / 2);
  ctx.drawImage(a.img, sx, sy, sw, sh, ox + r.x + Math.floor((r.w - sw) / 2), oy + r.y + Math.floor((r.h - sh) / 2), sw, sh);
}

/** Slight room tint over floor (multiply: preserves grain and grout). */
function tintFloor(ctx: CanvasRenderingContext2D, px: { x: number; y: number; w: number; h: number }, color: string): void {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return;
  const n = parseInt(m[1], 16);
  // mixes 10% of color with white: just a whisper of color
  const k = 0.1;
  const ch = (v: number) => Math.round(255 + (v - 255) * k);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
  ctx.fillRect(px.x, px.y, px.w, px.h);
  ctx.restore();
}

export function buildAreaVis(art: ArtModule, layout: AreaLayout, room: RoomState | undefined, assets: WorldAssets | null, theme: SeasonalTheme = 'none'): AreaVis {
  const r = layout.rect;
  const px = { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };

  // ---- floor + rugs
  const [floor, fctx] = makeCanvas(px.w, px.h);
  fctx.translate(-px.x, -px.y);
  for (const f of layout.floors) {
    try {
      art.drawFloor(fctx, f.kind, f.x, f.y, f.w, f.h, { seed: f.seed, tint: f.tint, tint2: f.tint2 });
    } catch {
      fctx.fillStyle = '#d9dde2';
      fctx.fillRect(f.x, f.y, f.w, f.h);
    }
  }
  if (layout.floorTint) tintFloor(fctx, px, layout.floorTint);
  for (const rug of layout.rugs) {
    const color = seasonalRugColor(theme, rug.color);
    try {
      art.drawRug(fctx, rug.x, rug.y, rug.w, rug.h, color, rug.seed);
    } catch {
      fctx.fillStyle = color;
      fctx.fillRect(rug.x, rug.y, rug.w, rug.h);
    }
    decorateSeasonalRug(fctx, theme, rug);
  }

  // ---- walls + fixed wall items
  const [walls, wctx] = makeCanvas(px.w, px.h + WALL_MARGIN);
  wctx.translate(-px.x, -px.y + WALL_MARGIN);
  const order = { face: 0, south: 1, cap: 2 } as const;
  for (const w of [...layout.walls].sort((a, b) => order[a.kind] - order[b.kind])) drawWallSegment(art, wctx, { ...w, style: seasonalWallStyle(theme, w.style) });
  for (const w of layout.walls) decorateSeasonalWall(wctx, theme, w);

  const wallItems: WallVis[] = [];
  let sign: WallVis | undefined;
  for (const it of layout.wallItems) {
    const vis = toWallVis(it, layout.id);
    if (DYNAMIC_WALL.has(it.kind)) {
      if (it.kind === 'sign') sign = vis;
      else wallItems.push(vis);
      continue;
    }
    // paintings and posters: ready-made AI art (when available) instead of procedural
    const ai = it.kind === 'painting' || it.kind === 'poster' ? pickWallArt(assets, it.kind, it.kind === 'poster' ? 1 : it.variant === 'wide' ? 4 : 2, it.variant, vis.seed) : null;
    if (ai && vis.on === 'face' && drawWallArtAsset(wctx, vis, ai)) continue;
    const s = wallSprites(art, it.kind, it.variant === 'wide' ? undefined : it.variant, 0, vis.seed);
    if (!s) continue;
    const o = wallItemOrigin(vis, s.base);
    wctx.drawImage(s.base.canvas, o.x, o.y);
    if (ai && it.kind === 'painting') drawRawPainting(wctx, s.base, o.x, o.y, ai);
  }

  // ---- furniture
  const furniture: FurnVis[] = layout.furniture.map((f) => {
    const def = FURNITURE[f.kind];
    const ax = (f.tx + def.footprint.w / 2) * TILE + (f.dx ?? 0);
    const ay = (f.ty + def.footprint.h) * TILE + (f.dy ?? 0);
    return {
      id: f.id,
      kind: f.kind,
      variant: f.variant,
      seed: hash32(f.id),
      ax,
      ay,
      order: f.order,
      areaId: layout.id,
      seatSpot: layout.spots.find((s) => s.deskId === f.id)?.id,
      states: [],
    };
  });

  return { id: layout.id, layout, room, px, floor, walls, furniture, wallItems, sign, version: room?.version ?? 0 };
}

export function toWallVis(it: WallItemPlacement, areaId: string): WallVis {
  return { id: it.id, kind: it.kind, variant: it.variant, seed: hash32(it.id), cx: it.cx, baseY: it.baseY, on: it.on, order: it.order, areaId };
}

/** Draws walls and floor of a set of segments/floors in an already transformed context (base layer). */
export function paintShell(art: ArtModule, ctx: CanvasRenderingContext2D, floors: AreaLayout['floors'], walls: WallSegment[]): void {
  for (const f of floors) {
    try {
      art.drawFloor(ctx, f.kind, f.x, f.y, f.w, f.h, { seed: f.seed, tint: f.tint, tint2: f.tint2 });
    } catch {
      ctx.fillStyle = '#9fc77f';
      ctx.fillRect(f.x, f.y, f.w, f.h);
    }
  }
  for (const w of walls) drawWallSegment(art, ctx, w);
}
