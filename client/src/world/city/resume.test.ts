// Returning to city: initial `pos` matching last keeps everything as-is; another location snaps;
// with nothing saved, standard fresh spawn.
import { describe, expect, it } from 'vitest';
import { RESUME_SAME_TILES, resumePlacement, type CityResume } from './resume';

const R: CityResume = { camX: 640, camY: 480, zoom: 2.5, following: true, me: { x: 21.4, y: 15.6 } };

describe('resumePlacement', () => {
  it('same location (with server rounding): keep', () => {
    expect(resumePlacement(R, { x: 21.4, y: 15.6 })).toBe('keep');
    expect(resumePlacement(R, { x: 21, y: 16 })).toBe('keep');
    expect(resumePlacement(R, { x: 21.4 + RESUME_SAME_TILES - 0.01, y: 15.6 })).toBe('keep');
  });

  it('different location: snap (direct, no animation)', () => {
    expect(resumePlacement(R, { x: 21.4 + RESUME_SAME_TILES + 0.01, y: 15.6 })).toBe('snap');
    expect(resumePlacement(R, { x: 3, y: 40 })).toBe('snap');
  });

  it('nothing saved, no previous character or no pos: fresh', () => {
    expect(resumePlacement(null, { x: 1, y: 1 })).toBe('fresh');
    expect(resumePlacement({ ...R, me: null }, { x: 21.4, y: 15.6 })).toBe('fresh');
    expect(resumePlacement(R, null)).toBe('fresh');
    expect(resumePlacement(R, { x: Number.NaN, y: 1 })).toBe('fresh');
  });
});
