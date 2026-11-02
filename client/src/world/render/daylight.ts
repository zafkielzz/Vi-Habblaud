// Day/night cycle (pure): phase of the day, light level, and tint colors for the exterior and
// interiors based on local time, effective hour (preference, ?hora= from URL), and parameter parsing.
// Drawing (light map, halos) is in lighting.ts.
import type { DaylightMode } from '../api';

export type { DaylightMode };
export type DayPhase = 'madrugada' | 'amanhecer' | 'dia' | 'entardecer' | 'noite';

export type Rgb = readonly [number, number, number];

export interface Ambient {
  hour: number;
  phase: DayPhase;
  /** 0 = full day, 1 = deep night. */
  night: number;
  /** 0..1: intensity of the warm tint of dawn/dusk. */
  warm: number;
  /** Tint multiplication over outdoor area (lawn, street, gardens). */
  outside: Rgb;
  /** Tint multiplication over lit interiors (rooms with people, corridor, reception). */
  inside: Rgb;
  /** Tint multiplication over empty common areas at night (nightlight). */
  dim: Rgb;
}

/** Hour used when cycle is fixed to "always day" / "always night". */
export const FIXED_DAY_HOUR = 13.5;
export const FIXED_NIGHT_HOUR = 22.5;

export const WHITE: Rgb = [255, 255, 255];
/** Lamp light (interiors at night). */
const LAMP: Rgb = [244, 220, 184];
/** Low sun entering through windows (dawn/dusk). */
const SUN: Rgb = [255, 222, 184];
/** Empty common area at night: bluish twilight. */
const VIGIL: Rgb = [138, 144, 180];

/**
 * Sky keyframes across the day: [hour, night, warm, outside color]. Linear interpolation,
 * seamless around midnight (0 h and 24 h are identical). Early morning is slightly darker
 * than early night; dawn shifts through violet and pink, dusk through gold and
 * orange into twilight purple.
 */
const KEYS: readonly (readonly [number, number, number, Rgb])[] = [
  [0, 1, 0, [70, 84, 140]],
  [4.5, 1, 0, [72, 86, 142]],
  [5.25, 0.86, 0.25, [104, 100, 156]],
  [5.9, 0.56, 0.8, [190, 146, 168]],
  [6.5, 0.2, 1, [255, 208, 174]],
  [7.25, 0, 0.35, [255, 238, 220]],
  [8, 0, 0, WHITE],
  [16.25, 0, 0, WHITE],
  [17.25, 0.04, 0.45, [255, 236, 206]],
  [18, 0.24, 1, [255, 202, 162]],
  [18.6, 0.55, 0.75, [194, 148, 164]],
  [19.25, 0.85, 0.3, [110, 108, 162]],
  [20, 1, 0, [80, 96, 150]],
  [24, 1, 0, [70, 84, 140]],
];

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Hour normalized to [0, 24). */
export function wrapHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return ((hour % 24) + 24) % 24;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp(t, 0, 1);
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

export function phaseOf(hour: number): DayPhase {
  const h = wrapHour(hour);
  if (h < 5) return 'madrugada';
  if (h < 7) return 'amanhecer';
  if (h < 17) return 'dia';
  if (h < 19) return 'entardecer';
  return 'noite';
}

/** Light level and colors by fractional local hour (0–24). */
export function ambientAt(hour: number): Ambient {
  const h = wrapHour(hour);
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= h) i++;
  const [h0, n0, w0, c0] = KEYS[i];
  const [h1, n1, w1, c1] = KEYS[i + 1];
  const u = (h - h0) / Math.max(1e-6, h1 - h0);
  const night = n0 + (n1 - n0) * u;
  const warm = w0 + (w1 - w0) * u;
  const outside = mixRgb(c0, c1, u);
  // lit interiors: warm lamp at night; by day, a touch of low sunlight through windows
  const inside = mixRgb(mixRgb(WHITE, LAMP, night), SUN, warm * (1 - night) * 0.55);
  const dim = mixRgb(WHITE, VIGIL, night);
  return { hour: h, phase: phaseOf(h), night, warm, outside, inside, dim };
}

/** Neutral ambient (full day): multiplying by it changes nothing. */
export function isNeutral(a: Ambient): boolean {
  return a.night < 0.005 && a.outside[0] >= 254 && a.outside[1] >= 254 && a.outside[2] >= 254 && a.inside[2] >= 254;
}

/** Nudges `cur` toward `target` (smooth transition when changing preference or fixed hour). */
export function approachAmbient(cur: Ambient, target: Ambient, k: number): Ambient {
  const t = clamp(k, 0, 1);
  if (t >= 1) return target;
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    hour: target.hour,
    phase: target.phase,
    night: lerp(cur.night, target.night),
    warm: lerp(cur.warm, target.warm),
    outside: mixRgb(cur.outside, target.outside, t),
    inside: mixRgb(cur.inside, target.inside, t),
    dim: mixRgb(cur.dim, target.dim, t),
  };
}

/** Distance between two ambients (to check if transition has ended). */
export function ambientDistance(a: Ambient, b: Ambient): number {
  let d = Math.abs(a.night - b.night) * 255 + Math.abs(a.warm - b.warm) * 255;
  for (let i = 0; i < 3; i++) d += Math.abs(a.outside[i] - b.outside[i]) + Math.abs(a.inside[i] - b.inside[i]) + Math.abs(a.dim[i] - b.dim[i]);
  return d;
}

/**
 * Sunbeams through north wall windows: floor length (world px), horizontal skew
 * per px down (negative in the morning: sun comes from east and light tilts west),
 * and opacity. null outside daylight hours. Sunbeams grow with low sun and are strongest
 * in early morning and late afternoon.
 */
export function sunbeamAt(hour: number): { len: number; skew: number; alpha: number } | null {
  const h = wrapHour(hour);
  if (h <= 6.1 || h >= 18.4) return null;
  // sun arc: 0 at sunrise (6 h) and sunset (18 h), 1 at noon
  const p = clamp((h - 6) / 12, 0, 1);
  const elevation = Math.sin(p * Math.PI);
  const len = clamp(18 + (1 - elevation) * 70, 18, 88);
  const skew = clamp(-Math.cos(p * Math.PI) * 0.9, -0.9, 0.9);
  // smooth fade-in/out near sunrise/sunset; peak in early morning and late afternoon
  const edge = Math.min(clamp((h - 6.1) / 0.6, 0, 1), clamp((18.4 - h) / 0.6, 0, 1));
  const golden = Math.max(0, 1 - Math.abs(h - 7.2) / 1.6, 1 - Math.abs(h - 17.2) / 1.6);
  return { len: Math.round(len), skew, alpha: edge * (0.12 + 0.2 * golden) };
}

/**
 * Reads the hour parameter from URL (`?hora=21:30`, `21h30`, `21h`, `21`, `6:05`). Returns fractional
 * hour (0–24) or null if missing/invalid.
 */
export function parseHourParam(search: string | null | undefined): number | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('hora');
  } catch {
    return null;
  }
  if (raw === null) return null;
  const m = /^\s*(\d{1,2})(?:\s*[:h]\s*(\d{2})?)?\s*$/i.exec(raw);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  if (hh > 24 || mm > 59 || (hh === 24 && mm > 0)) return null;
  return wrapHour(hh + mm / 60);
}

/** Effective cycle hour: override (URL/debug) takes precedence over preference; otherwise local time. */
export function effectiveHour(mode: DaylightMode, override: number | null, date: Date): number {
  if (override !== null && Number.isFinite(override)) return wrapHour(override);
  if (mode === 'day') return FIXED_DAY_HOUR;
  if (mode === 'night') return FIXED_NIGHT_HOUR;
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

/** Cycle mode from world options (`dayNight` is the legacy switch, still accepted). */
export function daylightModeOf(o: { daylight?: DaylightMode; dayNight: boolean }): DaylightMode {
  if (o.daylight === 'auto' || o.daylight === 'day' || o.daylight === 'night') return o.daylight;
  return o.dayNight ? 'auto' : 'day';
}

export function rgbCss(c: Rgb): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
