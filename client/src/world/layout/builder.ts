// Area builder in LOCAL coordinates (tiles relative to area corner).
// Converts everything to absolute coordinates and registers spots consistently.
import { FURNITURE, type Dir, type FloorKind, type FurnitureKind, type WallStyle } from '../../art/api';
import { FOOT_DX, FOOT_DY, TILE } from '../constants';
import type { AreaKind, AreaLayout, Doorway, FurniturePlacement, SpotDef, SpotKind, TileRect } from './types';

/** Seated character feet: px above seat base. */
export const SEAT_FOOT_DY = 3;
/** Extra depth for seated characters (right after the seat, before the backrest). */
export const SEATED_SORT_BIAS = 0.25;

export interface SpotOpts {
  /** Final position offset (px). */
  dx?: number;
  dy?: number;
  seated?: boolean;
  furnitureId?: string;
  sortY?: number;
  group?: string;
  deskId?: string;
  rank?: number;
  side?: 'S' | 'N';
  /** Absolute final position in px (overrides calculation from tile). */
  x?: number;
  y?: number;
}

export class AreaBuilder {
  readonly area: AreaLayout;
  private seq = 0;

  constructor(id: string, kind: AreaKind, rect: TileRect) {
    this.area = { id, kind, rect, floors: [], rugs: [], walls: [], wallItems: [], furniture: [], spots: [], walkable: [] };
  }

  get x0(): number {
    return this.area.rect.x;
  }

  get y0(): number {
    return this.area.rect.y;
  }

  /** Absolute px of a local tile coordinate (accepts fractions). */
  px(lx: number): number {
    return (this.x0 + lx) * TILE;
  }

  py(ly: number): number {
    return (this.y0 + ly) * TILE;
  }

  floor(kind: FloorKind, lx: number, ly: number, w: number, h: number, seed: number, tint?: string, tint2?: string): this {
    this.area.floors.push({ kind, x: this.px(lx), y: this.py(ly), w: w * TILE, h: h * TILE, seed, tint, tint2 });
    return this;
  }

  rug(lx: number, ly: number, w: number, h: number, color: string, seed: number): this {
    this.area.rugs.push({ x: Math.round(this.px(lx)), y: Math.round(this.py(ly)), w: Math.round(w * TILE), h: Math.round(h * TILE), color, seed });
    return this;
  }

  /** North wall face (2 tiles) between lx and lx+w (local tiles, accepts fractions). */
  face(lx: number, w: number, style: WallStyle, doorways: { lx: number; w: number }[] = [], ly = 0): this {
    this.area.walls.push({ kind: 'face', x: this.px(lx), y: this.py(ly), w: w * TILE, style, doorways: this.doors(doorways) });
    return this;
  }

  south(lx: number, w: number, ly: number, style: WallStyle, doorways: { lx: number; w: number }[] = []): this {
    this.area.walls.push({ kind: 'south', x: this.px(lx), y: this.py(ly), w: w * TILE, style, doorways: this.doors(doorways) });
    return this;
  }

  cap(lx: number, ly: number, w: number, h: number, style: WallStyle): this {
    this.area.walls.push({ kind: 'cap', x: this.px(lx), y: this.py(ly), w: w * TILE, h: h * TILE, style });
    return this;
  }

  private doors(list: { lx: number; w: number }[]): Doorway[] | undefined {
    return list.length ? list.map((d) => ({ x: this.px(d.lx), w: d.w * TILE })) : undefined;
  }

  /** Wall item centered on `lcx` (local tiles). `ly` = local baseboard row (default 2 = base of north face). */
  wall(kind: FurnitureKind, lcx: number, variant?: string, opts: { ly?: number; on?: 'face' | 'south'; order?: number } = {}): string {
    const id = `${this.area.id}#w${this.seq++}:${kind}`;
    this.area.wallItems.push({
      id,
      kind,
      variant,
      cx: Math.round(this.px(lcx)),
      baseY: this.py(opts.ly ?? 2),
      on: opts.on ?? 'face',
      order: opts.order ?? 0.5,
    });
    return id;
  }

  /** Floor furniture with footprint top-left corner at (lx, ly). */
  furn(kind: FurnitureKind, lx: number, ly: number, variant?: string, opts: { dx?: number; dy?: number; order?: number; seat?: string } = {}): string {
    const id = `${this.area.id}#f${this.seq++}:${kind}`;
    const f: FurniturePlacement = {
      id,
      kind,
      variant,
      tx: this.x0 + lx,
      ty: this.y0 + ly,
      dx: opts.dx,
      dy: opts.dy,
      order: opts.order ?? 0.5,
      seat: opts.seat,
    };
    this.area.furniture.push(f);
    return id;
  }

  /** Spot with approach at local tile (lx, ly). Default final position = feet on tile. */
  spot(kind: SpotKind, lx: number, ly: number, dir: Dir, opts: SpotOpts = {}): SpotDef {
    const tx = this.x0 + lx;
    const ty = this.y0 + ly;
    const s: SpotDef = {
      id: `${this.area.id}#s${this.seq++}:${kind}`,
      kind,
      areaId: this.area.id,
      tx,
      ty,
      x: opts.x ?? tx * TILE + FOOT_DX + (opts.dx ?? 0),
      y: opts.y ?? ty * TILE + FOOT_DY + (opts.dy ?? 0),
      dir,
      seated: opts.seated,
      furnitureId: opts.furnitureId,
      sortY: opts.sortY,
      group: opts.group,
      deskId: opts.deskId,
      rank: opts.rank,
      side: opts.side,
    };
    this.area.spots.push(s);
    return s;
  }

  /**
   * Seat (chair, stool, armchair...) at local tile (lx, ly). Character approaches
   * via the seat tile itself and snaps into seating position (with optional `dx` in px).
   */
  seat(kind: SpotKind, furnitureKind: FurnitureKind, lx: number, ly: number, dir: Dir, variant?: string, opts: SpotOpts & { order?: number; noFurniture?: boolean } = {}): SpotDef {
    const furnitureId = opts.noFurniture ? opts.furnitureId : this.furn(furnitureKind, lx, ly, variant, { dx: opts.dx, order: opts.order });
    const base = this.py(ly + 1);
    return this.spot(kind, lx, ly, dir, {
      ...opts,
      furnitureId,
      seated: true,
      x: this.px(lx) + TILE / 2 + (opts.dx ?? 0),
      y: base - SEAT_FOOT_DY + (opts.dy ?? 0),
      sortY: base + SEATED_SORT_BIAS,
    });
  }

  walk(lx: number, ly: number, w: number, h: number): this {
    this.area.walkable.push({ x: this.x0 + lx, y: this.y0 + ly, w, h });
    return this;
  }

  block(lx: number, ly: number, w: number, h: number): this {
    (this.area.blocked ??= []).push({ x: this.x0 + lx, y: this.y0 + ly, w, h });
    return this;
  }

  build(): AreaLayout {
    return this.area;
  }
}

/** Tiles blocked by floor furniture. */
export function furnitureBlocks(kind: FurnitureKind): boolean {
  const def = FURNITURE[kind];
  return def.mount === 'floor' && def.blocks;
}

/** Seat tiles (walkable, but avoided by A*). */
export function furnitureIsSeat(kind: FurnitureKind): boolean {
  const def = FURNITURE[kind];
  return def.mount === 'floor' && !!def.seat;
}
