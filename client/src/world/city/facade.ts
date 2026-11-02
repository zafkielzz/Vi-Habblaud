// Procedural facade of city buildings (pixel art in office style: blue-gray outline, 3–4 tones per
// material, top/left light, highlights and contact shadows).
//
// In 3/4 view the camera only sees the SOUTH face of buildings. The bottom row of the block has doors facing south:
// we see the front facade (ground floor with storefront, door, and sign). The top row has doors facing north: we see
// the roof with the striped entrance marquee on the north edge and, below, the back face (windows, fire escape,
// service door). In both cases the drawing fits entirely on the lot (depth of 12 tiles): the top row touches its top
// to the north sidewalk and the bottom row touches its base to the south sidewalk, so no building covers sidewalk or street.
//
// Pure model (`facadeModel`: floors, "+N", lit and blinking windows, style) and sprite cached by key
// (`facadeSprites`): base + emissive layer (what glows at night: lit windows, sign, theme lights).
import { mulberry32 } from '../../../../shared/hash';
import { tr } from '../../../../shared/i18n';
import type { WorldBuildingPublic, WorldTheme } from '../../../../shared/world/protocol';
import { pixelText, pixelTextWidth } from '../../art/pixelfont';
import { renderSeasonalProp, type SeasonalProp } from '../../art/seasonal';

/** Facade dimensions (world px). */
export const FACADE = {
  /** Building width: 12 tiles (the lot has 14; 1 tile alley on each side). */
  w: 192,
  /** Shadow on the right (in the alley). */
  shadow: 6,
  /** Roof viewed from above + eaves. */
  roof: 26,
  /** Each floor (windows). */
  floor: 11,
  /** Ground floor (storefront, door, and sign in front; service door in back). */
  ground: 30,
  /** Facade draws up to 12 floors; above that, "+N" rooftop sign. */
  maxFloors: 12,
  /** Windows per floor. */
  cols: 11,
  /** First window (x) and step between windows. */
  winX: 11,
  winPitch: 16,
  winW: 10,
  winH: 7,
} as const;

/** Facade styles (color, material, details), chosen by the lot seed. */
export interface FacadeStyle {
  name: string;
  /** Wall tones, from darkest to lightest. */
  wall: [string, string, string, string];
  pattern: 'brick' | 'panel' | 'stucco' | 'glass' | 'stone';
  /** Stone/cornice/sills. */
  trim: [string, string];
  /** Roof (slab viewed from above): base and edge. */
  roof: [string, string];
  /** Accent color (marquee, sign, awning). */
  accent: [string, string];
  /** Window frame. */
  frame: string;
}

export const FACADE_STYLES: readonly FacadeStyle[] = [
  { name: 'tijolo', wall: ['#7c3a2c', '#9c4935', '#b45a42', '#c87256'], pattern: 'brick', trim: ['#cfc3b0', '#ece4d6'], roof: ['#5d6470', '#7a828e'], accent: ['#2f6fa8', '#4f93cf'], frame: '#3a2a26' },
  { name: 'tijolo claro', wall: ['#9a7656', '#b48c66', '#c9a27a', '#dcb990'], pattern: 'brick', trim: ['#e6ddd0', '#f6f1e8'], roof: ['#646a74', '#848a94'], accent: ['#1f7f75', '#2fa597'], frame: '#4a3a2c' },
  { name: 'concreto', wall: ['#6f7884', '#87909c', '#9ea7b2', '#b9c1ca'], pattern: 'panel', trim: ['#d6dce3', '#eef1f4'], roof: ['#4b525c', '#666d78'], accent: ['#d98a2b', '#f2a33a'], frame: '#2e3648' },
  { name: 'reboco', wall: ['#c9c0b0', '#ddd5c6', '#ece6da', '#f8f4ec'], pattern: 'stucco', trim: ['#a8977c', '#c4b49a'], roof: ['#6f665e', '#8e857b'], accent: ['#a8322a', '#cf4a3c'], frame: '#4a4038' },
  { name: 'vidro', wall: ['#3f6f96', '#5587b0', '#6fa3c9', '#9cc6e4'], pattern: 'glass', trim: ['#cdd8e2', '#eef3f7'], roof: ['#353d48', '#4c5562'], accent: ['#7451b8', '#9a78dc'], frame: '#e8eef4' },
  { name: 'tijolo escuro', wall: ['#3e3433', '#4f4241', '#5f5150', '#73625f'], pattern: 'brick', trim: ['#bdae98', '#d8ccb8'], roof: ['#383b42', '#50545c'], accent: ['#c8902a', '#e8b04a'], frame: '#1f1a1a' },
  { name: 'painel verde', wall: ['#3a6e6a', '#467f7b', '#559491', '#6caba7'], pattern: 'panel', trim: ['#dfe9e7', '#f3f8f7'], roof: ['#3f4a53', '#58646e'], accent: ['#d8603f', '#f07c5a'], frame: '#24403e' },
  { name: 'arenito', wall: ['#b39b74', '#c6ae86', '#d8c39d', '#e8d6b4'], pattern: 'stone', trim: ['#7f6a4c', '#9c8562'], roof: ['#675e52', '#83796b'], accent: ['#2f66b8', '#3f7fd8'], frame: '#4a3d2c' },
  { name: 'marinho', wall: ['#1f2c4a', '#283a5e', '#314870', '#3d5884'], pattern: 'panel', trim: ['#d58a24', '#f2a33a'], roof: ['#262b36', '#3a404c'], accent: ['#d58a24', '#f2a33a'], frame: '#141b30' },
  { name: 'menta', wall: ['#7fae96', '#93bea8', '#a9cdb8', '#c3dfcd'], pattern: 'stucco', trim: ['#f0ece2', '#fbf9f4'], roof: ['#5f6871', '#7b848d'], accent: ['#c95e8e', '#e47aa8'], frame: '#3d5a4c' },
];

/** Variations per lot (style × lit window order): cache does not grow with the number of lots. */
export const FACADE_VARIANTS = 40;

/** Light levels (ratio of lit windows in eighths). */
export const LIT_LEVELS = 8;

export type FacadeSide = 'front' | 'back';

export interface FacadeModel {
  side: FacadeSide;
  variant: number;
  style: number;
  /** Drawn floors (0..12) and remainder for the "+N" sign. */
  drawn: number;
  plus: number;
  state: 'online' | 'away';
  theme: WorldTheme;
  /** Discreet mode: no counts (fixed medium light, nothing blinking). */
  discreet: boolean;
  /** Eighths of lit windows (0..8). */
  litLevel: number;
  /** Indices (in the drawn window grid) of lit ones and blinking ones (`waiting`). */
  lit: number[];
  waiting: number[];
  /** Total sprite height (px). */
  height: number;
}

/** Height (px) of the building with `floors` drawn floors. */
export function facadeHeight(floors: number): number {
  const drawn = Math.max(0, Math.min(FACADE.maxFloors, Math.floor(floors)));
  return FACADE.roof + drawn * FACADE.floor + FACADE.ground;
}

/** Deterministic order in which windows light up (shuffled by variant). */
export function windowOrder(variant: number, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const rng = mulberry32((variant * 2654435761) >>> 0);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * What the facade displays for a building. Lit windows in the ratio `working / total` (in eighths); `waiting` ones
 * blink (next in order, at least one if someone is waiting); `away` turns off all; discreet mode (no `agents`) lights
 * half, without blinking.
 */
export function facadeModel(b: Pick<WorldBuildingPublic, 'floors' | 'state' | 'theme' | 'agents'>, side: FacadeSide, seed: number): FacadeModel {
  const floors = Number.isFinite(b.floors) ? Math.max(0, Math.floor(b.floors)) : 0;
  const drawn = Math.min(FACADE.maxFloors, floors);
  const plus = Math.max(0, floors - FACADE.maxFloors);
  const variant = (seed >>> 0) % FACADE_VARIANTS;
  const count = drawn * FACADE.cols;
  const state = b.state === 'online' ? 'online' : 'away';
  const discreet = !b.agents;
  let litLevel = 0;
  let waitingN = 0;
  if (state === 'online') {
    if (!b.agents) litLevel = LIT_LEVELS / 2;
    else {
      const total = Math.max(0, b.agents.total);
      if (total > 0) {
        const working = Math.max(0, Math.min(total, b.agents.working));
        litLevel = Math.round((working / total) * LIT_LEVELS);
        if (working > 0 && litLevel === 0) litLevel = 1;
        const waiting = Math.max(0, Math.min(total, b.agents.waiting));
        if (waiting > 0) waitingN = Math.max(1, Math.round((waiting / total) * count));
      }
    }
  }
  const order = windowOrder(variant, count);
  const litN = Math.round((count * litLevel) / LIT_LEVELS);
  const lit = order.slice(0, litN);
  const waiting = order.slice(litN, Math.min(count, litN + waitingN));
  const theme: WorldTheme = b.theme === 'halloween' || b.theme === 'christmas' ? b.theme : 'none';
  return { side, variant, style: variant % FACADE_STYLES.length, drawn, plus, state, theme, discreet, litLevel, lit, waiting, height: facadeHeight(drawn) };
}

/** Sprite cache key (everything that changes the drawing; name, flag, and likes stay outside: they are screen text). */
export function facadeKey(m: FacadeModel): string {
  return `${m.side}|${m.variant}|${m.drawn}|${Math.min(99, m.plus)}|${m.state}|${m.theme}|${m.litLevel}`;
}

/** Rectangle (px, in sprite) of window `i` in the drawn grid (floor 0 = bottom one). */
export function windowRect(m: Pick<FacadeModel, 'drawn'>, i: number): { x: number; y: number; w: number; h: number } {
  const col = i % FACADE.cols;
  const fromBottom = Math.floor(i / FACADE.cols);
  const k = m.drawn - 1 - fromBottom;
  return { x: FACADE.winX + col * FACADE.winPitch, y: FACADE.roof + k * FACADE.floor + 2, w: FACADE.winW, h: FACADE.winH };
}

/** Where the owner's name sign goes (px, in sprite): ground floor sign in front; rooftop in back. */
export function signRect(m: Pick<FacadeModel, 'side' | 'height'>): { x: number; y: number; w: number; h: number } {
  if (m.side === 'front') return { x: 34, y: m.height - FACADE.ground + 2, w: FACADE.w - 68, h: 8 };
  return { x: 50, y: 11, w: FACADE.w - 100, h: 8 };
}

// ====================================================================== rendering (browser)

export interface FacadeSprites {
  canvas: HTMLCanvasElement;
  /** What glows at night (drawn on top after darkening the scene). */
  glow: HTMLCanvasElement;
  w: number;
  h: number;
}

const cache = new Map<string, FacadeSprites>();
const CACHE_LIMIT = 600;

/** Facade sprite (base and emissive layer), cached by model key. */
export function facadeSprites(m: FacadeModel): FacadeSprites {
  const key = facadeKey(m);
  let s = cache.get(key);
  if (s) return s;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  s = paintFacade(m);
  cache.set(key, s);
  return s;
}

/** Is this facade sprite already ready (drawing costs nothing)? */
export function facadeReady(m: FacadeModel): boolean {
  return cache.has(facadeKey(m));
}

export function facadeCacheSize(): number {
  return cache.size;
}

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

const OUTLINE = '#2e3648';
const WARM = ['#c98f3c', '#f2c66b', '#ffe3a0', '#fff4d2'] as const;
const GLASS = ['#1f3550', '#2b4868', '#3c5f84', '#7fa6cc'] as const;

const seasonal = new Map<SeasonalProp, HTMLCanvasElement>();
function seasonalCanvas(kind: SeasonalProp): HTMLCanvasElement {
  let c = seasonal.get(kind);
  if (!c) {
    const { buf } = renderSeasonalProp(kind);
    c = document.createElement('canvas');
    c.width = buf.w;
    c.height = buf.h;
    c.getContext('2d')!.putImageData(new ImageData(buf.data, buf.w, buf.h), 0, 0);
    seasonal.set(kind, c);
  }
  return c;
}

/** Draws the seasonal ornament with bottom center at (x, y), clipping empty sprite space (40×64). */
function drawSeasonal(ctx: Ctx, kind: SeasonalProp, x: number, y: number): void {
  const c = seasonalCanvas(kind);
  ctx.drawImage(c, Math.round(x - 20), Math.round(y - 60));
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function paintFacade(m: FacadeModel): FacadeSprites {
  const W = FACADE.w + FACADE.shadow;
  const H = m.height;
  const [c, ctx] = canvas(W, H);
  const [g, gctx] = canvas(W, H);
  const st = FACADE_STYLES[m.style]!;
  const rng = mulberry32(((m.variant + 1) * 0x9e3779b1) >>> 0);
  const on = m.state === 'online';
  const faceTop = FACADE.roof;
  const groundTop = H - FACADE.ground;
  const fw = FACADE.w;

  // ---- alley shadow (on the right) and ground contact
  ctx.fillStyle = 'rgba(28,36,52,0.22)';
  ctx.fillRect(fw, 6, FACADE.shadow, H - 6);
  ctx.fillStyle = 'rgba(28,36,52,0.12)';
  ctx.fillRect(fw, 10, 2, H - 10);

  // ---- upper floor and ground floor walls
  paintWall(ctx, st, 0, faceTop, fw, H - faceTop, rng);
  // slabs between floors and corner pillars
  for (let k = 0; k <= m.drawn; k++) {
    const y = faceTop + k * FACADE.floor;
    rect(ctx, 0, y - 1, fw, 1, st.pattern === 'glass' ? st.trim[0] : shade(st.wall[0], -0.08));
  }
  rect(ctx, 0, faceTop, 3, H - faceTop, st.trim[0]);
  rect(ctx, fw - 3, faceTop, 3, H - faceTop, st.trim[0]);
  rect(ctx, 0, faceTop, 1, H - faceTop, st.trim[1]);

  // ---- windows
  const litSet = new Set(m.lit);
  const count = m.drawn * FACADE.cols;
  for (let i = 0; i < count; i++) {
    const r = windowRect(m, i);
    paintWindow(ctx, st, r.x, r.y, litSet.has(i), (m.variant * 31 + i) % 7);
    if (litSet.has(i)) paintWindowGlow(gctx, r.x, r.y);
  }

  // ---- back: fire escape and AC units
  if (m.side === 'back' && m.drawn > 0) {
    const left = m.variant % 2 === 0;
    const ex = left ? FACADE.winX + FACADE.winPitch - 3 : FACADE.winX + (FACADE.cols - 2) * FACADE.winPitch - 3;
    paintFireEscape(ctx, ex, faceTop, m.drawn);
    for (let k = 0; k < m.drawn; k++) {
      if (rng() < 0.45) {
        const col = 2 + Math.floor(rng() * (FACADE.cols - 4));
        const r = windowRect(m, (m.drawn - 1 - k) * FACADE.cols + col);
        paintAcUnit(ctx, r.x + 1, r.y + r.h + 1);
      }
    }
  }

  // ---- ground floor
  if (m.side === 'front') paintStorefront(ctx, gctx, st, m, groundTop, on, rng);
  else paintServiceGround(ctx, gctx, st, m, groundTop, on, rng);

  // ---- roof and eaves
  paintRoof(ctx, gctx, st, m, rng);

  // ---- theme
  paintTheme(ctx, gctx, m, groundTop);
  if (m.side === 'back') paintEntranceFromAbove(ctx, gctx, st, m);
  // closed: sign on the door (front) or on the marquee (back), on top of everything
  if (!on) paintClosedSign(ctx, fw / 2, m.side === 'front' ? groundTop + 16 : 1);

  // ---- rooftop "+N" sign
  if (m.plus > 0) {
    const text = `+${Math.min(99, m.plus)}`;
    const tw = pixelTextWidth(text);
    const px = m.side === 'front' ? fw - tw - 18 : 16;
    const py = m.side === 'front' ? 6 : 13;
    rect(ctx, px - 3, py - 3, tw + 6, 11, OUTLINE);
    rect(ctx, px - 2, py - 2, tw + 4, 9, on ? st.accent[1] : '#5a6170');
    rect(ctx, px - 2, py - 2, tw + 4, 1, on ? lighten(st.accent[1], 0.25) : '#6d7483');
    pixelText(ctx, text, px, py, '#ffffff');
    rect(ctx, px + tw / 2 - 1, py + 8, 2, 3, OUTLINE);
    if (on) {
      gctx.fillStyle = 'rgba(255,255,255,0.85)';
      pixelText(gctx, text, px, py, '#fff6dc');
    }
  }
  return { canvas: c, glow: g, w: W, h: H };
}

function paintWall(ctx: Ctx, st: FacadeStyle, x: number, y: number, w: number, h: number, rng: () => number): void {
  const [d, b, l, hl] = st.wall;
  rect(ctx, x, y, w, h, b);
  switch (st.pattern) {
    case 'brick':
      for (let yy = y; yy < y + h; yy += 3) {
        const off = ((yy - y) / 3) % 2 === 0 ? 0 : 3;
        rect(ctx, x, yy + 2, w, 1, d);
        for (let xx = x + off; xx < x + w; xx += 6) {
          rect(ctx, xx, yy, 1, 2, d);
          const r = rng();
          if (r < 0.18) rect(ctx, xx + 1, yy, 5, 2, l);
          else if (r < 0.26) rect(ctx, xx + 1, yy, 5, 2, shade(b, -0.06));
        }
      }
      break;
    case 'panel':
      for (let xx = x; xx < x + w; xx += 24) rect(ctx, xx, y, 1, h, d);
      for (let yy = y + 5; yy < y + h; yy += 11) rect(ctx, x, yy, w, 1, shade(b, -0.05));
      rect(ctx, x, y, w, 1, l);
      break;
    case 'stucco':
      for (let i = 0; i < (w * h) / 40; i++) {
        const px = x + Math.floor(rng() * w);
        const py = y + Math.floor(rng() * h);
        rect(ctx, px, py, 1, 1, rng() < 0.5 ? l : shade(b, -0.04));
      }
      break;
    case 'stone':
      for (let yy = y; yy < y + h; yy += 5) {
        rect(ctx, x, yy + 4, w, 1, d);
        const off = ((yy - y) / 5) % 2 === 0 ? 0 : 7;
        for (let xx = x + off; xx < x + w; xx += 14) {
          rect(ctx, xx, yy, 1, 4, d);
          if (rng() < 0.3) rect(ctx, xx + 1, yy, 13, 1, hl);
        }
      }
      break;
    case 'glass':
      // glass curtain wall: glass is the wall; light mullions at each window
      rect(ctx, x, y, w, h, st.wall[1]);
      for (let yy = y; yy < y + h; yy++) {
        const k = (yy - y) % 11;
        if (k < 3) rect(ctx, x, yy, w, 1, st.wall[2]);
      }
      for (let xx = x + 3; xx < x + w; xx += 16) rect(ctx, xx, y, 1, h, st.frame);
      // diagonal sky reflection
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (let i = 0; i < h; i++) ctx.fillRect(x + ((i * 2 + 40) % (w + 40)) - 20, y + i, 10, 1);
      break;
  }
}

function paintWindow(ctx: Ctx, st: FacadeStyle, x: number, y: number, lit: boolean, v: number): void {
  const w = FACADE.winW;
  const h = FACADE.winH;
  if (st.pattern !== 'glass') {
    // frame and sill
    rect(ctx, x - 1, y - 1, w + 2, h + 2, st.frame);
    rect(ctx, x - 1, y + h + 1, w + 2, 1, st.trim[1]);
    rect(ctx, x - 1, y + h + 2, w + 2, 1, shade(st.trim[0], -0.15));
  }
  if (lit) {
    rect(ctx, x, y, w, h, WARM[2]);
    rect(ctx, x, y, w, 2, WARM[3]);
    rect(ctx, x, y + h - 2, w, 2, WARM[1]);
    // bluish desk monitor and sometimes someone with their back turned
    rect(ctx, x + 2 + (v % 4), y + h - 3, 3, 2, '#5fb8f0');
    rect(ctx, x + 2 + (v % 4), y + h - 3, 1, 1, '#c8ecff');
    if (v === 2 || v === 5) rect(ctx, x + 6 - (v % 3), y + h - 4, 2, 3, '#7a5a3a');
  } else {
    rect(ctx, x, y, w, h, GLASS[1]);
    rect(ctx, x, y, w, 2, GLASS[0]);
    rect(ctx, x, y + h - 1, w, 1, GLASS[2]);
    // reflection
    rect(ctx, x + 1 + (v % 3), y + 2, 1, 3, GLASS[3]);
    rect(ctx, x + 2 + (v % 3), y + 2, 1, 1, '#b8d2ea');
    if (v === 4) rect(ctx, x + 1, y + 1, w - 2, 2, '#c9cfd9'); // lowered blind
  }
  // frame divider
  rect(ctx, x + (w >> 1), y, 1, h, st.pattern === 'glass' ? st.frame : shade(st.frame, 0.1));
}

function paintWindowGlow(g: Ctx, x: number, y: number): void {
  const w = FACADE.winW;
  const h = FACADE.winH;
  g.fillStyle = WARM[2];
  g.fillRect(x, y, w, h);
  g.fillStyle = WARM[3];
  g.fillRect(x, y, w, 2);
  g.fillStyle = '#5fb8f0';
  g.fillRect(x + 3, y + h - 3, 3, 2);
  // glow spilling through the glass
  g.fillStyle = 'rgba(255,214,140,0.35)';
  g.fillRect(x - 1, y - 1, w + 2, h + 2);
}

function paintFireEscape(ctx: Ctx, x: number, faceTop: number, floors: number): void {
  const col = '#2a2f3a';
  const hi = '#5b6475';
  for (let k = 0; k < floors; k++) {
    const y = faceTop + k * FACADE.floor + FACADE.floor - 2;
    // platform with railing
    rect(ctx, x - 2, y, 18, 1, hi);
    rect(ctx, x - 2, y + 1, 18, 1, col);
    rect(ctx, x - 2, y - 4, 18, 1, col);
    for (let i = 0; i < 18; i += 3) rect(ctx, x - 2 + i, y - 4, 1, 4, col);
    // zigzag ladder to the platform below
    if (k < floors - 1) {
      const dir = k % 2 === 0 ? 1 : -1;
      for (let s = 0; s < FACADE.floor; s++) rect(ctx, x + 7 + dir * (s - 5), y + 2 + s, 2, 1, s % 2 ? col : hi);
    }
  }
}

function paintAcUnit(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x, y, 7, 4, OUTLINE);
  rect(ctx, x + 1, y, 5, 3, '#c9d0d8');
  rect(ctx, x + 1, y, 5, 1, '#e8edf2');
  rect(ctx, x + 2, y + 1, 3, 1, '#8b95a3');
}

/** Front ground floor: sign, storefront windows, double glass door, lamps, and step. */
function paintStorefront(ctx: Ctx, g: Ctx, st: FacadeStyle, m: FacadeModel, top: number, on: boolean, rng: () => number): void {
  const fw = FACADE.w;
  const H = m.height;
  const base = H - 2;
  // ground floor stone band
  rect(ctx, 0, top, fw, FACADE.ground, st.trim[0]);
  rect(ctx, 0, top, fw, 1, st.trim[1]);
  rect(ctx, 0, top + 1, fw, 1, shade(st.trim[0], -0.2));
  // sign (the name plate is drawn on top, in screen space)
  const sign = signRect(m);
  rect(ctx, sign.x - 2, sign.y - 1, sign.w + 4, sign.h + 2, OUTLINE);
  rect(ctx, sign.x - 1, sign.y, sign.w + 2, sign.h, on ? st.accent[0] : '#4a505c');
  rect(ctx, sign.x - 1, sign.y, sign.w + 2, 1, on ? st.accent[1] : '#5b6270');
  if (on) {
    g.fillStyle = 'rgba(255,240,200,0.55)';
    g.fillRect(sign.x - 1, sign.y, sign.w + 2, sign.h);
  }
  // display windows on both sides of the door
  const dx0 = fw / 2 - 16;
  const dx1 = fw / 2 + 16;
  const vy = top + 12;
  const vh = base - vy - 2;
  for (const [x0, x1] of [
    [6, dx0 - 6],
    [dx1 + 6, fw - 6],
  ] as const) {
    rect(ctx, x0 - 1, vy - 1, x1 - x0 + 2, vh + 2, OUTLINE);
    if (on) {
      rect(ctx, x0, vy, x1 - x0, vh, WARM[2]);
      rect(ctx, x0, vy, x1 - x0, 2, WARM[3]);
      rect(ctx, x0, vy + vh - 3, x1 - x0, 3, WARM[1]);
      // shelves/tables and plants inside
      for (let x = x0 + 4; x < x1 - 4; x += 9 + Math.floor(rng() * 5)) {
        rect(ctx, x, vy + vh - 6, 5, 3, '#8a6243');
        if (rng() < 0.5) rect(ctx, x + 1, vy + vh - 9, 3, 3, '#4b8a45');
        else rect(ctx, x + 1, vy + vh - 8, 3, 2, '#5fb8f0');
      }
      g.fillStyle = WARM[2];
      g.fillRect(x0, vy, x1 - x0, vh);
      g.fillStyle = 'rgba(255,214,140,0.3)';
      g.fillRect(x0 - 2, vy - 2, x1 - x0 + 4, vh + 4);
    } else {
      rect(ctx, x0, vy, x1 - x0, vh, GLASS[1]);
      rect(ctx, x0, vy, x1 - x0, 2, GLASS[0]);
      for (let x = x0 + 3; x < x1; x += 13) rect(ctx, x, vy + 2, 2, vh - 3, GLASS[2]);
    }
    for (let x = x0 + 16; x < x1 - 2; x += 16) rect(ctx, x, vy, 1, vh, st.frame === '#e8eef4' ? '#cdd8e2' : OUTLINE);
    // awning over the display window
    rect(ctx, x0 - 1, vy - 4, x1 - x0 + 2, 3, st.accent[0]);
    for (let x = x0; x < x1; x += 4) rect(ctx, x, vy - 4, 2, 3, st.accent[1]);
    rect(ctx, x0 - 1, vy - 1, x1 - x0 + 2, 1, shade(st.accent[0], -0.25));
  }
  // double glass door
  const dy = top + 9;
  rect(ctx, dx0 - 2, dy - 2, 36, base - dy + 2, OUTLINE);
  rect(ctx, dx0 - 1, dy - 1, 34, base - dy + 1, st.trim[1]);
  for (const x of [dx0, fw / 2 + 1]) {
    rect(ctx, x, dy, 15, base - dy, OUTLINE);
    rect(ctx, x + 1, dy + 1, 13, base - dy - 1, on ? '#f6dd9a' : GLASS[1]);
    rect(ctx, x + 1, dy + 1, 13, 2, on ? WARM[3] : GLASS[0]);
    rect(ctx, x + 2, dy + 3, 1, base - dy - 6, on ? '#fff6dc' : GLASS[3]);
    rect(ctx, x === dx0 ? x + 12 : x + 2, dy + 9, 1, 4, '#c9cfd9');
    if (on) {
      g.fillStyle = '#f6dd9a';
      g.fillRect(x + 1, dy + 1, 13, base - dy - 1);
    }
  }
  // step and stone base
  rect(ctx, 0, base, fw, 2, shade(st.trim[0], -0.25));
  rect(ctx, dx0 - 4, base - 1, 40, 3, '#c9cdd3');
  rect(ctx, dx0 - 4, base - 1, 40, 1, '#e4e7eb');
  // lamps on both sides of the door
  for (const x of [dx0 - 6, dx1 + 4]) {
    rect(ctx, x, dy + 2, 3, 4, OUTLINE);
    rect(ctx, x + 1, dy + 3, 1, 2, on ? '#fff1b8' : '#8b95a3');
    if (on) {
      g.fillStyle = 'rgba(255,230,160,0.9)';
      g.fillRect(x, dy + 2, 3, 4);
      g.fillStyle = 'rgba(255,220,150,0.25)';
      g.fillRect(x - 3, dy, 9, 10);
    }
  }
}

/** Back ground floor: wall with service door, high small windows, dumpsters, and bike rack. */
function paintServiceGround(ctx: Ctx, g: Ctx, st: FacadeStyle, m: FacadeModel, top: number, on: boolean, rng: () => number): void {
  const fw = FACADE.w;
  const base = m.height - 2;
  rect(ctx, 0, top, fw, 2, shade(st.wall[0], -0.1));
  // high small windows
  for (let x = 12; x < fw - 12; x += 22) {
    if (Math.abs(x + 5 - fw / 2) < 18) continue;
    rect(ctx, x - 1, top + 5, 12, 6, st.frame);
    const lit = on && rng() < 0.5;
    rect(ctx, x, top + 6, 10, 4, lit ? WARM[2] : GLASS[1]);
    rect(ctx, x, top + 6, 10, 1, lit ? WARM[3] : GLASS[0]);
    if (lit) {
      g.fillStyle = WARM[2];
      g.fillRect(x, top + 6, 10, 4);
    }
  }
  // service door (metal) with lamp
  const dx = fw / 2 - 7;
  rect(ctx, dx - 1, top + 9, 16, base - top - 9, OUTLINE);
  rect(ctx, dx, top + 10, 14, base - top - 10, '#7d8794');
  rect(ctx, dx, top + 10, 14, 1, '#a9b2bd');
  rect(ctx, dx + 11, top + 18, 1, 3, '#d9dee4');
  rect(ctx, dx + 3, top + 12, 8, 2, '#5f6875');
  rect(ctx, dx + 5, top + 6, 4, 2, on ? '#fff1b8' : '#8b95a3');
  if (on) {
    g.fillStyle = 'rgba(255,230,160,0.9)';
    g.fillRect(dx + 5, top + 6, 4, 2);
  }
  // dumpsters and parked bicycles
  for (const [x, c] of [
    [22, '#3f7f4f'],
    [32, '#2f5f9e'],
  ] as const) {
    rect(ctx, x - 1, base - 9, 9, 9, OUTLINE);
    rect(ctx, x, base - 8, 7, 8, c);
    rect(ctx, x, base - 8, 7, 2, lighten(c, 0.2));
  }
  const bx = fw - 40;
  for (let i = 0; i < 2; i++) {
    const x = bx + i * 12;
    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + 2.5, base - 3.5, 3, 0, Math.PI * 2);
    ctx.arc(x + 10.5, base - 3.5, 3, 0, Math.PI * 2);
    ctx.stroke();
    rect(ctx, x + 3, base - 6, 7, 1, i ? '#cf4a3c' : '#2fa597');
  }
  rect(ctx, 0, base, fw, 2, shade(st.trim[0], -0.25));
}

/** Hanging "Closed" sign (text in viewer's language, in pixels). */
function paintClosedSign(ctx: Ctx, cx: number, y: number): void {
  const text = tr('Closed');
  const tw = Math.min(40, pixelTextWidth(text));
  const w = tw + 6;
  const x = Math.round(cx - w / 2);
  rect(ctx, x + 2, y - 4, 1, 4, '#3a2a20');
  rect(ctx, x + w - 3, y - 4, 1, 4, '#3a2a20');
  rect(ctx, x - 1, y - 1, w + 2, 10, '#3a2a20');
  rect(ctx, x, y, w, 8, '#c98f5a');
  rect(ctx, x, y, w, 1, '#e3ad78');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 3, y, tw, 8);
  ctx.clip();
  pixelText(ctx, text, x + 3, y + 2, '#3a2a20');
  ctx.restore();
}

/** Roof viewed from above: edge, slab, water tank, air conditioner, skylight; in back, entrance marquee. */
function paintRoof(ctx: Ctx, g: Ctx, st: FacadeStyle, m: FacadeModel, rng: () => number): void {
  const fw = FACADE.w;
  const R = FACADE.roof;
  const on = m.state === 'online';
  // slab
  rect(ctx, 0, 0, fw, R - 5, OUTLINE);
  rect(ctx, 1, 1, fw - 2, R - 6, st.roof[1]);
  rect(ctx, 3, 3, fw - 6, R - 10, st.roof[0]);
  // gravel texture
  for (let i = 0; i < 90; i++) rect(ctx, 3 + Math.floor(rng() * (fw - 6)), 3 + Math.floor(rng() * (R - 10)), 1, 1, rng() < 0.5 ? st.roof[1] : shade(st.roof[0], -0.12));
  // eaves (south edge of the slab, facing the camera)
  rect(ctx, 0, R - 5, fw, 4, st.trim[0]);
  rect(ctx, 0, R - 5, fw, 1, st.trim[1]);
  rect(ctx, 0, R - 2, fw, 1, shade(st.trim[0], -0.3));
  rect(ctx, 0, R - 1, fw, 1, 'rgba(28,36,52,0.35)');
  // rooftop equipment
  const slots = m.side === 'back' ? [14, 150] : [14, 60, 120, 160];
  for (const sx of slots) {
    const r = rng();
    const x = sx + Math.floor(rng() * 10);
    if (r < 0.35) {
      // water tank
      rect(ctx, x, 4, 12, 12, OUTLINE);
      rect(ctx, x + 1, 5, 10, 10, '#9aa6b4');
      rect(ctx, x + 1, 5, 10, 3, '#c3ccd6');
      rect(ctx, x + 3, 6, 6, 1, '#e3e8ee');
    } else if (r < 0.7) {
      // air conditioner with fan
      rect(ctx, x, 6, 14, 9, OUTLINE);
      rect(ctx, x + 1, 7, 12, 7, '#d4dae1');
      rect(ctx, x + 1, 7, 12, 2, '#eef1f4');
      rect(ctx, x + 4, 9, 6, 4, '#8b95a3');
      rect(ctx, x + 6, 10, 2, 2, '#5f6875');
    } else {
      // skylight
      rect(ctx, x, 6, 16, 9, OUTLINE);
      rect(ctx, x + 1, 7, 14, 7, on ? '#9cc6e4' : '#3c5f84');
      rect(ctx, x + 1, 7, 14, 2, '#c8e2f4');
      rect(ctx, x + 8, 7, 1, 7, OUTLINE);
    }
  }
  if (rng() < 0.5) {
    // antenna
    const ax = m.side === 'back' ? 176 : 100 + Math.floor(rng() * 40);
    rect(ctx, ax, 1, 1, 9, '#4a5468');
    rect(ctx, ax - 2, 3, 5, 1, '#4a5468');
    rect(ctx, ax, 1, 1, 1, on ? '#ff5a4a' : '#8b95a3');
    if (on) {
      g.fillStyle = '#ff5a4a';
      g.fillRect(ax, 1, 1, 1);
    }
  }
}

/** Back: entrance is on the north, so the striped marquee extends from the roof edge, with the sign right behind it. */
function paintEntranceFromAbove(ctx: Ctx, g: Ctx, st: FacadeStyle, m: FacadeModel): void {
  const fw = FACADE.w;
  const on = m.state === 'online';
  {
    const sign = signRect(m);
    rect(ctx, sign.x - 2, sign.y - 1, sign.w + 4, sign.h + 2, OUTLINE);
    rect(ctx, sign.x - 1, sign.y, sign.w + 2, sign.h, on ? st.accent[0] : '#4a505c');
    rect(ctx, sign.x - 1, sign.y, sign.w + 2, 1, on ? st.accent[1] : '#5b6270');
    if (on) {
      g.fillStyle = 'rgba(255,240,200,0.55)';
      g.fillRect(sign.x - 1, sign.y, sign.w + 2, sign.h);
    }
    const ax0 = fw / 2 - 22;
    rect(ctx, ax0 - 1, 0, 46, 10, OUTLINE);
    for (let x = 0; x < 44; x++) {
      const stripe = Math.floor(x / 4) % 2 === 0;
      rect(ctx, ax0 + x, 0, 1, 9, stripe ? st.accent[1] : '#f6efe2');
    }
    rect(ctx, ax0, 0, 44, 2, 'rgba(255,255,255,0.35)');
    rect(ctx, ax0, 7, 44, 2, 'rgba(28,36,52,0.25)');
    // entrance lamps
    for (const x of [ax0 + 3, ax0 + 39]) {
      rect(ctx, x, 1, 2, 2, on ? '#fff1b8' : '#8b95a3');
      if (on) {
        g.fillStyle = 'rgba(255,230,160,0.95)';
        g.fillRect(x, 1, 2, 2);
      }
    }
  }
}

/** Owner's theme ornaments: Halloween (pumpkins, webs, bats, purple light) and Christmas (snow, lights, garland, tree). */
function paintTheme(ctx: Ctx, g: Ctx, m: FacadeModel, groundTop: number): void {
  if (m.theme === 'none') {
    if (m.side === 'front') {
      // planters and doormat at entrance
      const fw = FACADE.w;
      const base = m.height - 2;
      for (const x of [fw / 2 - 26, fw / 2 + 20]) {
        rect(ctx, x, base - 6, 6, 6, OUTLINE);
        rect(ctx, x + 1, base - 5, 4, 5, '#c97a4a');
        rect(ctx, x - 1, base - 11, 8, 6, '#3f8550');
        rect(ctx, x, base - 12, 6, 2, '#5aa45d');
      }
    }
    return;
  }
  const fw = FACADE.w;
  const R = FACADE.roof;
  const on = m.state === 'online';
  const xmas = m.theme === 'christmas';
  if (xmas) {
    // snow on roof and eaves
    ctx.fillStyle = '#f4f8fb';
    for (let x = 2; x < fw - 2; x += 1) {
      const k = Math.sin(x * 0.35) + Math.sin(x * 0.11);
      if (k > -0.4) ctx.fillRect(x, 2, 1, 2 + (k > 0.8 ? 1 : 0));
    }
    ctx.fillRect(0, R - 6, fw, 2);
    ctx.fillStyle = '#dbe6ee';
    ctx.fillRect(0, R - 4, fw, 1);
    for (let x = 6; x < fw - 6; x += 23) ctx.fillRect(x, 6 + (x % 7), 6, 2);
  }
  // string lights under the eaves (emissive)
  const colors = xmas ? ['#ff5a5a', '#ffd76a', '#6ad1ff', '#7be07b'] : ['#b06ae6', '#ff9a3c'];
  for (let x = 4, i = 0; x < fw - 2; x += 6, i++) {
    const y = R + (i % 2);
    rect(ctx, x, y - 1, 1, 1, '#2e3648');
    rect(ctx, x, y, 2, 2, colors[i % colors.length]!);
    if (on) {
      g.fillStyle = colors[i % colors.length]!;
      g.fillRect(x, y, 2, 2);
      g.globalAlpha = 0.35;
      g.fillRect(x - 1, y - 1, 4, 4);
      g.globalAlpha = 1;
    }
  }
  if (!xmas) {
    // webs on top corners and bats on the eaves
    ctx.strokeStyle = 'rgba(230,220,240,0.8)';
    ctx.lineWidth = 1;
    for (const side of [1, -1]) {
      const x = side === 1 ? 3.5 : fw - 3.5;
      const y = R + 0.5;
      ctx.beginPath();
      for (const [dx, dy] of [[9, 0], [7, 5], [0, 9]]) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + side * dx!, y + dy!);
      }
      ctx.moveTo(x + side * 4, y);
      ctx.lineTo(x + side * 3, y + 3);
      ctx.lineTo(x, y + 4);
      ctx.stroke();
    }
    for (const x of [40, 132]) {
      const y = R - 9;
      rect(ctx, x, y, 3, 2, '#47344f');
      rect(ctx, x - 3, y - 1, 3, 2, '#47344f');
      rect(ctx, x + 3, y - 1, 3, 2, '#47344f');
      rect(ctx, x + 1, y, 1, 1, '#f5b95f');
    }
  }
  const base = m.height - 2;
  if (m.side === 'front') {
    if (xmas) {
      // garland above the door and tree next to the entrance
      paintGarland(ctx, g, fw / 2 - 19, groundTop + 6, 38, on);
      drawSeasonal(ctx, 'tree', fw - 30, base + 2);
      drawSeasonal(ctx, 'gift', fw - 52, base + 2);
    } else {
      drawSeasonal(ctx, 'pumpkin', fw / 2 - 28, base + 2);
      drawSeasonal(ctx, 'pumpkin', fw / 2 + 28, base + 2);
      if (m.drawn > 0) drawSeasonal(ctx, 'ghost', 30, groundTop + 6);
    }
  } else {
    // in back, the ornament stays next to the service door
    if (xmas) {
      paintGarland(ctx, g, fw / 2 - 10, groundTop + 6, 20, on);
      drawSeasonal(ctx, 'tree', fw / 2 + 30, base + 2);
    } else {
      drawSeasonal(ctx, 'pumpkin', fw / 2 - 22, base + 2);
      drawSeasonal(ctx, 'pumpkin', fw / 2 + 22, base + 2);
    }
  }
}

/** Christmas garland (green with red bows and lights) over the door. */
function paintGarland(ctx: Ctx, g: Ctx, x: number, y: number, w: number, on: boolean): void {
  for (let i = 0; i < w; i++) {
    const sag = Math.round(Math.sin((i / w) * Math.PI) * 3);
    rect(ctx, x + i, y + sag, 1, 3, i % 3 === 0 ? '#245644' : '#347653');
    if (i % 6 === 3) {
      rect(ctx, x + i, y + sag + 2, 2, 2, ['#ffd76a', '#ff5a5a', '#6ad1ff'][(i / 6) % 3 | 0]!);
      if (on) {
        g.fillStyle = '#ffe9a8';
        g.fillRect(x + i, y + sag + 2, 2, 2);
      }
    }
  }
  for (const bx of [x - 1, x + w - 3]) {
    rect(ctx, bx, y - 1, 4, 3, '#c93945');
    rect(ctx, bx + 1, y + 2, 1, 3, '#a82d42');
    rect(ctx, bx + 2, y + 2, 1, 2, '#a82d42');
  }
}

// ------------------------------------------------------------------ colors

function hexRgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const v = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${v(r)}${v(g)}${v(b)}`;
}

/** Darkens (k < 0) or lightens (k > 0) a hex color. */
function shade(c: string, k: number): string {
  const [r, g, b] = hexRgb(c);
  if (k < 0) return toHex(r * (1 + k), g * (1 + k), b * (1 + k));
  return toHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
}

function lighten(c: string, k: number): string {
  return shade(c, Math.abs(k));
}
