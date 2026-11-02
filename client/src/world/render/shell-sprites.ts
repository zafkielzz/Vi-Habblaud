// Small shell waiting sprites drawn by the world itself: the hourglass "×N" badge and
// fallback versions of new icons (hourglass, cobweb, storm) — used only if the art module
// does not yet have them. Generated once (cached canvas), never per frame.
import type { IconName, Sprite } from '../../art/api';

/** 3x5 glyphs (3-bit rows) for the badge. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '×': ['000', '101', '010', '101', '000'],
  '+': ['000', '010', '111', '010', '000'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['110', '001', '010', '100', '111'],
  '3': ['110', '001', '010', '001', '110'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '110', '001', '110'],
  '6': ['011', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '110'],
};

const BADGE_BG = '#2b3346';
const BADGE_EDGE = '#151a26';
const BADGE_FG = '#ffe08a';

const badges = new Map<number, Sprite>();

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

/** Badge text: "×2" … "×9", "×9+" above that. */
export function badgeText(n: number): string {
  return n > 9 ? '×9+' : `×${Math.max(0, Math.floor(n))}`;
}

/**
 * "×N" badge (dark pill with light digits) for when there is more than one shell. Anchored at the
 * bottom-left corner (ax = 0, ay = height).
 */
export function countBadge(n: number): Sprite {
  const key = Math.min(10, Math.max(2, Math.floor(n)));
  let s = badges.get(key);
  if (s) return s;
  const text = badgeText(key);
  const glyphs = [...text];
  const tw = glyphs.length * 4 - 1;
  const w = tw + 4;
  const h = 9;
  const { c, ctx } = canvas(w, h);
  ctx.fillStyle = BADGE_EDGE;
  ctx.fillRect(1, 0, w - 2, h);
  ctx.fillRect(0, 1, w, h - 2);
  ctx.fillStyle = BADGE_BG;
  ctx.fillRect(1, 1, w - 2, h - 2);
  ctx.fillStyle = BADGE_FG;
  let x = 2;
  for (const g of glyphs) {
    const rows = GLYPHS[g];
    if (rows) for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (rows[r][k] === '1') ctx.fillRect(x + k, 2 + r, 1, 1);
    x += 4;
  }
  s = { canvas: c, ax: 0, ay: h };
  badges.set(key, s);
  return s;
}

// ------------------------------------------------------------------ fallback icons

interface Template {
  rows: readonly string[];
  pal: Readonly<Record<string, string>>;
  /** Dark 1 px outline (cobweb has none: thin strands). */
  outline?: boolean;
}

const OUT = '#2a3142';

const TEMPLATES: Partial<Record<IconName, Template>> = {
  hourglass: {
    rows: [
      'oooooooo',
      '.owwwwo.',
      '.oyyyyo.',
      '..oyyo..',
      '...oo...',
      '..owwo..',
      '.owyywo.',
      '.oyyyyo.',
      'oooooooo',
    ],
    pal: { o: '#8a5a2b', w: '#e8f4ff', y: '#ffd166' },
  },
  hourglass_flip: {
    rows: [
      '...oo...',
      '..owwo..',
      '.owwyyo.',
      'oowyyyoo',
      'o.oyyo.o',
      'oowwwwoo',
      '.owwwwo.',
      '..owwo..',
      '...oo...',
    ],
    pal: { o: '#8a5a2b', w: '#e8f4ff', y: '#ffd166' },
  },
  cobweb: {
    rows: [
      'w....w....w.',
      '.w...w...w..',
      '..wwwwwww...',
      '..w.w.w.w...',
      '.wwwwwwwww..',
      '..w.w.w.w...',
      '...wwwwww...',
      '....w.w.....',
      '.....ww.....',
      '......s.....',
      '......s.....',
      '.....kkk....',
    ],
    pal: { w: '#e9eef7', s: '#c9d1de', k: '#2b2b33' },
    outline: false,
  },
  storm: {
    rows: [
      '...cccc....',
      '.cccwwccc..',
      'cwwwwwwwcc.',
      'cwwwwwwwwwc',
      '.cccccyccc.',
      '.....yy....',
      '....yy.....',
      '.....y.....',
    ],
    pal: { c: '#7d8799', w: '#c3cad6', y: '#ffd23f' },
  },
};

const fallbacks = new Map<IconName, Sprite | null>();

/** Fallback icon (with 1 px outline) or null if none exists for this name. */
export function fallbackIcon(name: IconName): Sprite | null {
  if (fallbacks.has(name)) return fallbacks.get(name)!;
  const t = TEMPLATES[name];
  let s: Sprite | null = null;
  if (t && typeof document !== 'undefined') {
    const w = Math.max(...t.rows.map((r) => r.length));
    const h = t.rows.length;
    const { c, ctx } = canvas(w + 2, h + 2);
    // outline: paints neighbors of each pixel and then the pixel
    ctx.fillStyle = OUT;
    if (t.outline !== false) for (let y = 0; y < h; y++) for (let x = 0; x < t.rows[y].length; x++) if (t.pal[t.rows[y][x]]) ctx.fillRect(x, y, 3, 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < t.rows[y].length; x++) {
        const col = t.pal[t.rows[y][x]];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x + 1, y + 1, 1, 1);
      }
    }
    s = { canvas: c, ax: Math.floor((w + 2) / 2), ay: h + 2 };
  }
  fallbacks.set(name, s);
  return s;
}
