// Day/night cycle (pure): phases, light level and colors by hour and minute, midnight wrap,
// sunbeams, effective hour, and reading ?hora= from URL.
import { describe, expect, it } from 'vitest';
import {
  ambientAt,
  ambientDistance,
  approachAmbient,
  daylightModeOf,
  effectiveHour,
  FIXED_DAY_HOUR,
  FIXED_NIGHT_HOUR,
  isNeutral,
  mixRgb,
  parseHourParam,
  phaseOf,
  sunbeamAt,
  wrapHour,
} from './daylight';

const lum = (c: readonly [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('day phases', () => {
  it('night, dawn, day, dusk, and evening boundary checks', () => {
    expect(phaseOf(0)).toBe('madrugada');
    expect(phaseOf(4 + 59 / 60)).toBe('madrugada');
    expect(phaseOf(5)).toBe('amanhecer');
    expect(phaseOf(6.5)).toBe('amanhecer');
    expect(phaseOf(7)).toBe('dia');
    expect(phaseOf(16.99)).toBe('dia');
    expect(phaseOf(17)).toBe('entardecer');
    expect(phaseOf(18 + 59 / 60)).toBe('entardecer');
    expect(phaseOf(19)).toBe('noite');
    expect(phaseOf(23.99)).toBe('noite');
  });

  it('normalizes hours outside 0–24 (including negative values)', () => {
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(25.5)).toBe(1.5);
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(Number.NaN)).toBe(0);
    expect(phaseOf(-0.5)).toBe('noite');
    expect(phaseOf(28)).toBe('madrugada');
  });
});

describe('light level and colors', () => {
  it('noon is neutral (nothing to draw); night is dark and bluish', () => {
    const noon = ambientAt(12);
    expect(noon.night).toBe(0);
    expect(noon.outside).toEqual([255, 255, 255]);
    expect(noon.inside).toEqual([255, 255, 255]);
    expect(isNeutral(noon)).toBe(true);
    const late = ambientAt(22.5);
    expect(late.night).toBe(1);
    expect(isNeutral(late)).toBe(false);
    expect(lum(late.outside)).toBeLessThan(110);
    // bluish: blue dominates red in outdoor night
    expect(late.outside[2]).toBeGreaterThan(late.outside[0] + 40);
    // lit interiors remain bright (and warm: red dominates blue)
    expect(lum(late.inside)).toBeGreaterThan(200);
    expect(late.inside[0]).toBeGreaterThan(late.inside[2]);
    // empty common areas stay in dim light, between lit room and outdoors
    expect(lum(late.dim)).toBeLessThan(lum(late.inside));
    expect(lum(late.dim)).toBeGreaterThan(lum(late.outside));
  });

  it('dawn and dusk have a warm tone', () => {
    for (const h of [6.5, 18]) {
      const a = ambientAt(h);
      expect(a.warm).toBeGreaterThan(0.9);
      expect(a.outside[0]).toBeGreaterThan(a.outside[2] + 60);
    }
    expect(ambientAt(12).warm).toBe(0);
    expect(ambientAt(23).warm).toBe(0);
  });

  it('interpolates by minute: night grows continuously at dusk', () => {
    let prev = ambientAt(17).night;
    for (let m = 1; m <= 180; m++) {
      const a = ambientAt(17 + m / 60);
      expect(a.night).toBeGreaterThanOrEqual(prev - 1e-9);
      // no sudden jumps between adjacent minutes
      expect(a.night - prev).toBeLessThan(0.02);
      prev = a.night;
    }
    expect(prev).toBe(1);
    // midway between two keys: intermediate values
    const mid = ambientAt(18.3);
    expect(mid.night).toBeGreaterThan(ambientAt(18).night);
    expect(mid.night).toBeLessThan(ambientAt(18.6).night);
  });

  it('dawn brightens every minute', () => {
    let prev = ambientAt(5).night;
    for (let m = 1; m <= 180; m++) {
      const a = ambientAt(5 + m / 60);
      expect(a.night).toBeLessThanOrEqual(prev + 1e-9);
      prev = a.night;
    }
    expect(prev).toBe(0);
  });

  it('midnight transition is continuous', () => {
    const before = ambientAt(23 + 59 / 60);
    const after = ambientAt(0);
    const next = ambientAt(1 / 60);
    expect(ambientDistance(before, after)).toBeLessThan(3);
    expect(ambientDistance(after, next)).toBeLessThan(3);
    expect(ambientAt(24)).toEqual(ambientAt(0));
    // late night is slightly darker than early night
    expect(lum(ambientAt(2).outside)).toBeLessThan(lum(ambientAt(20).outside));
  });

  it('color blending and smooth transition between environments', () => {
    expect(mixRgb([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
    expect(mixRgb([10, 20, 30], [200, 200, 200], -1)).toEqual([10, 20, 30]);
    expect(mixRgb([10, 20, 30], [200, 200, 200], 2)).toEqual([200, 200, 200]);
    const day = ambientAt(12);
    const night = ambientAt(23);
    const half = approachAmbient(day, night, 0.5);
    expect(half.night).toBeCloseTo(0.5);
    expect(ambientDistance(half, night)).toBeLessThan(ambientDistance(day, night));
    expect(approachAmbient(day, night, 1)).toBe(night);
  });
});

describe('sunbeams through windows', () => {
  it('daytime only; short at noon, long with low sun', () => {
    expect(sunbeamAt(3)).toBeNull();
    expect(sunbeamAt(6)).toBeNull();
    expect(sunbeamAt(21)).toBeNull();
    const noon = sunbeamAt(12)!;
    const late = sunbeamAt(17.5)!;
    expect(late.len).toBeGreaterThan(noon.len);
    expect(Math.abs(noon.skew)).toBeLessThan(0.05);
  });

  it('morning tilts west, afternoon tilts east; strongest during golden hour', () => {
    expect(sunbeamAt(8)!.skew).toBeLessThan(0);
    expect(sunbeamAt(16)!.skew).toBeGreaterThan(0);
    expect(sunbeamAt(17.2)!.alpha).toBeGreaterThan(sunbeamAt(12)!.alpha);
    // fades in and out smoothly near sunrise/sunset
    expect(sunbeamAt(6.2)!.alpha).toBeLessThan(sunbeamAt(7.2)!.alpha);
  });
});

describe('effective hour and ?hora= parameter', () => {
  const date = new Date(2026, 9, 8, 14, 45, 0);

  it('reads accepted formats', () => {
    expect(parseHourParam('?hora=21:30')).toBe(21.5);
    expect(parseHourParam('?hora=6:05')).toBeCloseTo(6 + 5 / 60);
    expect(parseHourParam('?hora=06:00')).toBe(6);
    expect(parseHourParam('?hora=21h30')).toBe(21.5);
    expect(parseHourParam('?hora=21h')).toBe(21);
    expect(parseHourParam('?hora=18')).toBe(18);
    expect(parseHourParam('?mock=1&hora=22%3A30')).toBe(22.5);
    expect(parseHourParam('?hora=24:00')).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseHourParam('')).toBeNull();
    expect(parseHourParam(null)).toBeNull();
    expect(parseHourParam('?mock=1')).toBeNull();
    expect(parseHourParam('?hora=')).toBeNull();
    expect(parseHourParam('?hora=25:00')).toBeNull();
    expect(parseHourParam('?hora=12:60')).toBeNull();
    expect(parseHourParam('?hora=24:30')).toBeNull();
    expect(parseHourParam('?hora=meio-dia')).toBeNull();
    expect(parseHourParam('?hora=-3')).toBeNull();
  });

  it('forced hour overrides preference; otherwise preference; otherwise clock', () => {
    expect(effectiveHour('auto', null, date)).toBeCloseTo(14.75);
    expect(effectiveHour('day', null, date)).toBe(FIXED_DAY_HOUR);
    expect(effectiveHour('night', null, date)).toBe(FIXED_NIGHT_HOUR);
    expect(effectiveHour('day', 21.5, date)).toBe(21.5);
    expect(effectiveHour('auto', 26, date)).toBe(2);
    expect(ambientAt(FIXED_NIGHT_HOUR).night).toBe(1);
    expect(isNeutral(ambientAt(FIXED_DAY_HOUR))).toBe(true);
  });

  it('mode from world options (legacy toggle still applies)', () => {
    expect(daylightModeOf({ dayNight: true })).toBe('auto');
    expect(daylightModeOf({ dayNight: false })).toBe('day');
    expect(daylightModeOf({ dayNight: false, daylight: 'night' })).toBe('night');
    expect(daylightModeOf({ dayNight: true, daylight: 'day' })).toBe('day');
  });
});
