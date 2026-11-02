// Likes, stamps, and "knock on door" in city (Phase 5): nearest touchable door (like up to 4 tiles from
// door; knock and stamp up to 2; never on own building), client-side limits (like 10 per minute; knock 1 per
// minute per building), and flying heart to the sign. Pure (tested); rendering lives in social.ts.
import { lotDoor, type CityPoint } from '../../../../shared/world/city';
import type { WorldBuildingPublic } from '../../../../shared/world/protocol';
import { nearestDoor } from './layout';

/** Distances (tiles) to `lotDoor(lot).front`, matching the world server. */
export const LIKE_DISTANCE = 4;
export const KNOCK_DISTANCE = 2;
export const STAMP_DISTANCE = 2;
/**
 * Knock on door: once per minute per building (server rejects earlier). Client-side with leeway: commands
 * are sent in batches every 200 ms and may arrive closer together than sent.
 */
export const KNOCK_EVERY_MS = 62_000;
/** Duration of heart flying to sign. */
export const HEART_MS = 900;

export interface DoorTarget {
  building: WorldBuildingPublic;
  front: CityPoint;
  /** Distance (tiles) to door front. */
  dist: number;
}

/**
 * Nearest door (up to `max` tiles) of a city building other than own. `buildingAt` returns the building
 * at each lot (scene state).
 */
export function doorTarget(
  me: { x: number; y: number },
  buildingAt: (lot: CityPoint) => WorldBuildingPublic | undefined,
  myBuildingId: string | null,
  max: number,
): DoorTarget | null {
  const d = nearestDoor(me.x, me.y, (lot) => {
    const b = buildingAt(lot);
    return !!b && b.id !== myBuildingId;
  }, max);
  if (!d) return null;
  const building = buildingAt(d.lot);
  if (!building) return null;
  return { building, front: d.front, dist: Math.hypot(d.front.x - me.x, d.front.y - me.y) };
}

/** Distance (tiles) from local player to building door. */
export function doorDistance(me: { x: number; y: number }, b: Pick<WorldBuildingPublic, 'lot'>): number {
  const f = lotDoor(b.lot).front;
  return Math.hypot(f.x - me.x, f.y - me.y);
}

/** Current building button actions: like (nearby), knock (nearby and owner allows), and reasons why not. */
export interface DoorActions {
  canLike: boolean;
  canKnock: boolean;
  liked: boolean;
  mine: boolean;
}

export function doorActions(b: WorldBuildingPublic, me: { x: number; y: number } | null, myBuildingId: string | null): DoorActions {
  const mine = !!myBuildingId && b.id === myBuildingId;
  const dist = me ? doorDistance(me, b) : Infinity;
  return {
    canLike: !mine && dist <= LIKE_DISTANCE + 1e-9,
    canKnock: !mine && b.knocks === true && dist <= KNOCK_DISTANCE + 1e-9,
    liked: b.likedByMe === true,
    mine,
  };
}

/** Knocking on door: when each building was last knocked (client-side only). */
export class KnockBook {
  private readonly at = new Map<string, number>();

  /** Time remaining (ms) before knocking again at this building. */
  wait(buildingId: string, now: number): number {
    const t = this.at.get(buildingId);
    return t === undefined ? 0 : Math.max(0, t + KNOCK_EVERY_MS - now);
  }

  take(buildingId: string, now: number): boolean {
    if (this.wait(buildingId, now) > 0) return false;
    this.at.set(buildingId, now);
    return true;
  }
}

/** A heart flying from `from` to `to` (world px), in an arc. */
export interface HeartFlight {
  from: { x: number; y: number };
  to: { x: number; y: number };
  start: number;
  /** Unliking: heart falls from sign, broken. */
  broken?: boolean;
}

/** Heart position (world px), scale, and opacity; null once arrived. */
export function heartAt(f: HeartFlight, now: number): { x: number; y: number; scale: number; alpha: number } | null {
  const t = (now - f.start) / HEART_MS;
  if (t < 0 || t >= 1) return null;
  if (f.broken) {
    // falls from sign, swaying
    return { x: f.to.x + Math.sin(t * 9) * 3, y: f.to.y + t * t * 26, scale: 1, alpha: 1 - t };
  }
  const e = 1 - (1 - t) * (1 - t);
  const lift = Math.sin(t * Math.PI) * 26;
  const x = f.from.x + (f.to.x - f.from.x) * e;
  const y = f.from.y + (f.to.y - f.from.y) * e - lift;
  const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.8 : t > 0.8 ? 1.4 - ((t - 0.8) / 0.2) * 0.6 : 1.4;
  return { x, y, scale, alpha: t > 0.9 ? (1 - t) * 10 : 1 };
}

/** Pixel art heart (7×6), 1 = color, 2 = highlight. */
export const HEART_PIXELS: readonly string[] = ['.11.11.', '1211111', '1111111', '.11111.', '..111..', '...1...'];
