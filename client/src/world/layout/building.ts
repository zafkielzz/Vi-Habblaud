// Building assembly: core + corridor + project rooms -> walkability grid and spots.
import { FURNITURE } from '../../art/api';
import { BUILDING_H, COL_W, CORE_COLS, TILE } from '../constants';
import { BLOCKED, FREE, SEAT, WalkGrid } from '../path/grid';
import { furnitureBlocks, furnitureIsSeat } from './builder';
import { layoutCafe, layoutLounge, layoutReception, layoutRestroom } from './core';
import { layoutCorridor } from './corridor';
import { buildingRect } from './geometry';
import type { AreaLayout, SpotDef, TileRect } from './types';

/** One office's building on the street (several offices = several buildings side by side, in office order). */
export interface BuildingPart {
  /** OfficeInfo.id ('' = no offices: the one building). */
  id: string;
  index: number;
  /** First column (absolute) and width in columns (core + project columns). */
  col0: number;
  cols: number;
  /** Absolute tiles. */
  rect: TileRect;
  core: AreaLayout[];
  corridor: AreaLayout;
}

export interface BuildingLayout {
  /** Columns from the first building's west wall to the last one's east wall (gaps included). */
  cols: number;
  rect: TileRect;
  /** Every building's core areas (reception, restrooms, kitchen, lounge). */
  core: AreaLayout[];
  /** The first building's corridor (`corridors` has them all). */
  corridor: AreaLayout;
  corridors: AreaLayout[];
  rooms: AreaLayout[];
  /** Walkable grid over every building: buildings are not connected (the lawn between them is not walkable). */
  grid: WalkGrid;
  spots: SpotDef[];
  buildings: BuildingPart[];
}

/** Lawn between two buildings, in columns. */
export const BUILDING_GAP_COLS = 1;

/** Id suffix of a building's core areas, spots and furniture: none for the first building (unchanged ids). */
export function buildingSuffix(index: number, id: string): string {
  return index === 0 ? '' : `@${id}`;
}

/** First column of each building, in order (widths in columns, a lawn column between two buildings). */
export function buildingCols(widths: readonly number[]): number[] {
  const out: number[] = [];
  let x = 0;
  for (const w of widths) {
    out.push(x);
    x += w + BUILDING_GAP_COLS;
  }
  return out;
}

let coreCache: AreaLayout[] | null = null;

/** Fixed core areas (calculated once). */
export function coreAreas(): AreaLayout[] {
  return (coreCache ??= [layoutReception(), layoutRestroom(), layoutCafe(), layoutLounge()]);
}

/** Marks walkable cells, obstacles, and seats for an area on the grid. */
export function paintArea(grid: WalkGrid, area: AreaLayout): void {
  for (const r of area.walkable) grid.fill(r.x, r.y, r.w, r.h, FREE);
  for (const r of area.blocked ?? []) grid.fill(r.x, r.y, r.w, r.h, BLOCKED);
  for (const f of area.furniture) {
    const def = FURNITURE[f.kind];
    if (def.mount !== 'floor') continue;
    const { w, h } = def.footprint;
    if (furnitureBlocks(f.kind)) grid.fill(f.tx, f.ty, w, h, BLOCKED);
    else if (furnitureIsSeat(f.kind)) {
      for (let y = f.ty; y < f.ty + h; y++) for (let x = f.tx; x < f.tx + w; x++) if (grid.get(x, y) === FREE) grid.set(x, y, SEAT);
    }
  }
}

export function buildWalkGrid(cols: number, areas: readonly AreaLayout[], version = 0): WalkGrid {
  const grid = new WalkGrid(cols * COL_W, BUILDING_H, version);
  for (const a of areas) paintArea(grid, a);
  return grid;
}

/**
 * Moves an area `dc` columns east and suffixes its ids (area, spots, furniture, wall items, spot groups), so another
 * building's copy of a core area is distinct. dc = 0 and no suffix: the area itself.
 */
export function shiftArea(area: AreaLayout, dc: number, suffix: string): AreaLayout {
  if (!dc && !suffix) return area;
  const dt = dc * COL_W;
  const dp = dt * TILE;
  const id = (x: string) => (x.startsWith(area.id) ? area.id + suffix + x.slice(area.id.length) : x + suffix);
  const opt = (x: string | undefined) => (x === undefined ? undefined : id(x));
  const tiles = (r: TileRect) => ({ ...r, x: r.x + dt });
  return {
    ...area,
    id: area.id + suffix,
    rect: tiles(area.rect),
    floors: area.floors.map((f) => ({ ...f, x: f.x + dp })),
    rugs: area.rugs.map((r) => ({ ...r, x: r.x + dp })),
    walls: area.walls.map((w) => ('doorways' in w && w.doorways ? { ...w, x: w.x + dp, doorways: w.doorways.map((d) => ({ ...d, x: d.x + dp })) } : { ...w, x: w.x + dp })),
    wallItems: area.wallItems.map((w) => ({ ...w, id: id(w.id), cx: w.cx + dp })),
    furniture: area.furniture.map((f) => ({ ...f, id: id(f.id), tx: f.tx + dt })),
    spots: area.spots.map((s) => ({
      ...s,
      id: id(s.id),
      areaId: area.id + suffix,
      tx: s.tx + dt,
      x: s.x + dp,
      furnitureId: opt(s.furnitureId),
      group: s.group === undefined ? undefined : s.group + suffix,
      deskId: opt(s.deskId),
    })),
    walkable: area.walkable.map(tiles),
    ...(area.blocked ? { blocked: area.blocked.map(tiles) } : {}),
    ...(area.door ? { door: tiles(area.door) } : {}),
    ...(area.shade ? { shade: { ...area.shade, x: area.shade.x + dp } } : {}),
    ...(area.signId ? { signId: id(area.signId) } : {}),
  };
}

const partCache = new Map<string, { core: AreaLayout[]; corridor: AreaLayout }>();

/** A building's core and corridor at its place (cached: the same objects while nothing changed). */
function buildingAreas(index: number, id: string, col0: number, cols: number): { core: AreaLayout[]; corridor: AreaLayout } {
  const key = `${index}|${id}|${col0}|${cols}`;
  let hit = partCache.get(key);
  if (!hit) {
    const suffix = buildingSuffix(index, id);
    hit = { core: coreAreas().map((a) => shiftArea(a, col0, suffix)), corridor: shiftArea(layoutCorridor(cols), col0, suffix) };
    if (partCache.size > 64) partCache.clear();
    partCache.set(key, hit);
  }
  return hit;
}

/**
 * Every building of the street: `parts` in office order (id, width in columns), a lawn column between two. Project
 * rooms are already placed (their slots are absolute: see geometry.slotColumn).
 */
export function assembleCampus(parts: readonly { id: string; cols: number }[], rooms: readonly AreaLayout[], version = 0): BuildingLayout {
  const list = parts.length ? parts : [{ id: '', cols: CORE_COLS + 1 }];
  const starts = buildingCols(list.map((p) => p.cols));
  const buildings: BuildingPart[] = list.map((p, index) => {
    const col0 = starts[index];
    const { core, corridor } = buildingAreas(index, p.id, col0, p.cols);
    return { id: p.id, index, col0, cols: p.cols, rect: { ...buildingRect(p.cols), x: col0 * COL_W }, core, corridor };
  });
  const last = buildings[buildings.length - 1];
  const cols = last.col0 + last.cols;
  const core = buildings.flatMap((b) => b.core);
  const corridors = buildings.map((b) => b.corridor);
  const all = [...core, ...corridors, ...rooms];
  const grid = buildWalkGrid(cols, all, version);
  const spots: SpotDef[] = [];
  for (const a of all) spots.push(...a.spots);
  return { cols, rect: buildingRect(cols), core, corridor: corridors[0], corridors, rooms: [...rooms], grid, spots, buildings };
}

/** A single building (no offices, or one). */
export function assembleBuilding(cols: number, rooms: readonly AreaLayout[], version = 0): BuildingLayout {
  return assembleCampus([{ id: '', cols }], rooms, version);
}
