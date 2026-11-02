// Buffer sprites (pure) and drawing sheets with origin at furniture footprint.
import { TILE, type Rect, type SpriteRectName } from '../api';
import { PixelBuf } from './pixbuf';

export type Rects = Partial<Record<SpriteRectName, Rect>>;

/** Pure equivalent of Sprite: buffer + anchor + dynamic regions. */
export interface BufSprite {
  buf: PixelBuf;
  ax: number;
  ay: number;
  rects?: Rects;
}

export interface BufFurniture {
  base: BufSprite;
  front?: BufSprite;
}

/**
 * Sheet for floor furniture: drawing uses footprint coordinates — (0, 0) is top-left
 * corner of footprint and (w*TILE, h*TILE) is bottom-right. Anchor is bottom center.
 */
export function floorSheet(wTiles: number, hTiles: number, up: number, side = 4, down = 3): BufSprite {
  const buf = new PixelBuf(wTiles * TILE + side * 2, up + hTiles * TILE + down);
  buf.ox = side;
  buf.oy = up;
  return { buf, ax: side + (wTiles * TILE) / 2, ay: up + hTiles * TILE };
}

/**
 * Sheet for wall items: x = 0 is left edge of wall segment and y = 0 is baseboard
 * line (wall face goes from y = -2*TILE to 0). Anchor is bottom center of segment.
 */
export function wallSheet(wTiles: number, side = 2): BufSprite {
  const up = TILE * 2 + 4;
  const buf = new PixelBuf(wTiles * TILE + side * 2, up + 2);
  buf.ox = side;
  buf.oy = up;
  return { buf, ax: side + (wTiles * TILE) / 2, ay: up };
}

/** Converts a rectangle in drawing coordinates (with origin) to sprite px. */
export function rectAt(s: BufSprite, x: number, y: number, w: number, h: number): Rect {
  return { x: x + s.buf.ox, y: y + s.buf.oy, w, h };
}

/** Crops sprite to visible content, preserving anchor and regions. */
export function trim(s: BufSprite): BufSprite {
  const b = s.buf.bounds();
  if (!b) return s;
  const buf = s.buf.crop(b.x, b.y, b.w, b.h);
  let rects: Rects | undefined;
  if (s.rects) {
    rects = {};
    for (const [k, r] of Object.entries(s.rects) as [SpriteRectName, Rect][]) {
      rects[k] = { x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h };
    }
  }
  return { buf, ax: s.ax - b.x, ay: s.ay - b.y, rects };
}
