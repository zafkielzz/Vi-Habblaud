// The visitor of the Visit scene (PLANO.md, section 8.4): my character inside someone else's building. Enters through
// the reception elevator with the visitor badge, walks with the keyboard (free step, colliding with the building grid) or
// with a click (A* path) and never sits: seats count as walls for them. Kept outside `Sim.chars`: does not come
// from the snapshot, does not join social life, does not reserve spots, and does not toggle lights. In v1 no one else
// sees them (no step leaves here: position inside does not go to the world server). Pure rules (no DOM).
import type { AgentInfo } from '../../../../shared/types';
import type { AppearanceParts } from '../../../../shared/appearance';
import { hash32 } from '../../../../shared/hash';
import { tr } from '../../../../shared/i18n';
import type { Dir } from '../../art/api';
import { TILE } from '../constants';
import { RECEPTION_ID } from '../layout/core';
import { BLOCKED, SEAT, type WalkGrid } from '../path/grid';
import { dirOf } from './character';

/** Visitor id (never an agent id: neither from local office nor `world:`). */
export const VISITOR_ID = 'visita:eu';
/** Visitor badge color (lanyard and badge seal). */
export const VISITOR_LANYARD = '#ff8a3d';
/** Distance (tiles) from elevator front where "Leave by the elevator (E)" appears. */
export const EXIT_RADIUS = 1.6;

/** Where the keyboard steers the visitor: -1, 0, or 1 on each axis; `run` with Shift. */
export interface VisitorIntent {
  dx: number;
  dy: number;
  run: boolean;
}

export const NO_INTENT: Readonly<VisitorIntent> = { dx: 0, dy: 0, run: false };

/** My world character (the `me` of the scene), as a `Sim` agent only for rendering. */
export function visitorInfo(me: { name: string; look: 'f' | 'm'; parts?: AppearanceParts }, now: number): AgentInfo {
  return {
    id: VISITOR_ID,
    kind: 'main',
    provider: 'claude',
    roomId: RECEPTION_ID,
    name: me.name,
    look: me.look,
    ...(me.parts && Object.keys(me.parts).length ? { parts: me.parts } : {}),
    role: tr('Visitor'),
    sessionId: VISITOR_ID,
    account: '',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: now,
    lastEventAt: now,
    statusSince: now,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: hash32(`${VISITOR_ID}:${me.name}`),
  };
}

/** Tile where feet are located (world px). */
export function tileAt(x: number, y: number): { x: number; y: number } {
  return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
}

/** Margins (px) around feet that must be on free floor: body does not enter walls or furniture. */
const HALF_W = 4;
const UP = 4;
const DOWN = 2;

/** Can the visitor stand with feet at (x, y)? Free floor (seats count as walls: visitor does not sit). */
export function canStand(grid: WalkGrid, x: number, y: number): boolean {
  for (const [ox, oy] of [
    [-HALF_W, -UP],
    [HALF_W, -UP],
    [-HALF_W, DOWN],
    [HALF_W, DOWN],
  ] as const) {
    const t = tileAt(x + ox, y + oy);
    const c = grid.get(t.x, t.y);
    if (c === BLOCKED || c === SEAT) return false;
  }
  return true;
}

/**
 * A free step from the keyboard: moves `dist` px in requested direction (normalized diagonal), one axis at a time to
 * slide along walls. Returns new position, direction, and whether movement occurred.
 */
export function stepFree(grid: WalkGrid, pos: { x: number; y: number; dir: Dir }, intent: VisitorIntent, dist: number): { x: number; y: number; dir: Dir; moved: boolean } {
  let { dx, dy } = intent;
  dx = Math.sign(dx);
  dy = Math.sign(dy);
  if (!dx && !dy) return { ...pos, moved: false };
  const k = dx && dy ? Math.SQRT1_2 : 1;
  let { x, y } = pos;
  let moved = false;
  if (dx) {
    const nx = x + dx * dist * k;
    if (canStand(grid, nx, y)) {
      x = nx;
      moved = true;
    }
  }
  if (dy) {
    const ny = y + dy * dist * k;
    if (canStand(grid, x, ny)) {
      y = ny;
      moved = true;
    }
  }
  return { x, y, dir: dirOf(dx, dy, pos.dir), moved };
}
