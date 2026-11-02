// Several offices = several buildings side by side: each one a full copy of the core, its own rooms, not connected.
import { describe, expect, it } from 'vitest';
import type { RoomTheme } from '../../art/api';
import { COL_W, CORE_COLS } from '../constants';
import { assembleBuilding, assembleCampus, buildingCols, BUILDING_GAP_COLS, shiftArea } from './building';
import { RECEPTION_ID, layoutReception } from './core';
import { columnsFor } from './geometry';
import { layoutProjectRoom } from './room';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

describe('buildings side by side', () => {
  it('first columns: a lawn column between two buildings', () => {
    expect(buildingCols([3])).toEqual([0]);
    expect(buildingCols([3, 4, 3])).toEqual([0, 3 + BUILDING_GAP_COLS, 7 + 2 * BUILDING_GAP_COLS]);
  });

  it('one building: exactly the single-building layout', () => {
    const rooms = [layoutProjectRoom({ id: '/p/a', slot: 0, seed: 7 }, theme)];
    const one = assembleCampus([{ id: 'main', cols: 3 }], rooms);
    const old = assembleBuilding(3, rooms);
    expect(one.core).toEqual(old.core);
    expect(one.corridor).toEqual(old.corridor);
    expect(one.spots.map((s) => s.id)).toEqual(old.spots.map((s) => s.id));
    expect([...one.grid.cells]).toEqual([...old.grid.cells]);
  });

  it('a shifted area moves by whole columns and suffixes its ids', () => {
    const a = layoutReception();
    const b = shiftArea(a, 4, '@o2');
    expect(b.id).toBe(`${RECEPTION_ID}@o2`);
    expect(b.rect.x).toBe(a.rect.x + 4 * COL_W);
    expect(b.spots[0].x - a.spots[0].x).toBe(4 * COL_W * 16);
    expect(b.spots.every((s) => s.areaId === b.id && s.id.startsWith(b.id))).toBe(true);
    expect(b.furniture.every((f) => f.id.startsWith(b.id))).toBe(true);
    expect(new Set(b.spots.filter((s) => s.group).map((s) => s.group!.endsWith('@o2')))).toEqual(new Set([true]));
    expect(shiftArea(a, 0, '')).toBe(a);
  });

  it('two buildings: distinct ids, rooms at absolute slots, no path from one to the other', () => {
    const c0 = buildingCols([3, columnsFor([0])])[1];
    // the second building's slot 0 is absolute slot 2 * c0
    const rooms = [layoutProjectRoom({ id: '/p/a', slot: 0, seed: 7 }, theme), layoutProjectRoom({ id: '/p/b', slot: 2 * c0, seed: 9 }, theme)];
    const c = assembleCampus(
      [
        { id: 'a', cols: 3 },
        { id: 'b', cols: 3 },
      ],
      rooms,
    );
    expect(c.buildings.map((b) => [b.col0, b.cols])).toEqual([
      [0, 3],
      [c0, 3],
    ]);
    expect(c.cols).toBe(c0 + 3);
    expect(rooms[1].rect.x).toBe((c0 + CORE_COLS) * COL_W);
    const ids = c.spots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(c.core.filter((a) => a.kind === 'reception').map((a) => a.id)).toEqual([RECEPTION_ID, `${RECEPTION_ID}@b`]);
    const elev = c.core[0].spots.find((s) => s.kind === 'elevator')!;
    const reach = c.grid.reachableFrom(elev.tx, elev.ty);
    const other = c.buildings[1].core[0].spots.find((s) => s.kind === 'elevator')!;
    expect(reach[other.ty * c.grid.w + other.tx]).toBe(0);
    const roomB = rooms[1].spots.find((s) => s.kind === 'desk')!;
    const reachB = c.grid.reachableFrom(other.tx, other.ty);
    expect(reachB[roomB.ty * c.grid.w + roomB.tx]).toBe(1);
  });
});
