// Fictional floor names (shared/world/floor-names.ts, copied identically on world server) and translated labels.
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { floorLabel, isFloorNameId } from './floor-labels';
import { FLOOR_NAME_IDS } from './floor-names';

afterEach(() => setLocale('en'));

describe('floor names', () => {
  it('60 unique ASCII ids, and draw order starts with ipe, jade, and aurora', () => {
    expect(FLOOR_NAME_IDS).toHaveLength(60);
    expect(new Set(FLOOR_NAME_IDS).size).toBe(60);
    for (const id of FLOOR_NAME_IDS) expect(id).toMatch(/^[a-z]+$/);
    expect([FLOOR_NAME_IDS[0], FLOOR_NAME_IDS[20], FLOOR_NAME_IDS[40]]).toEqual(['ipe', 'jade', 'aurora']);
  });

  it('each id has its own label in supported locales', () => {
    expect(floorLabel('ipe')).toBe('Project Ipê');
    expect(floorLabel('lapislazuli')).toBe('Project Lapis Lazuli');
    setLocale('en');
    const labels = FLOOR_NAME_IDS.map(floorLabel);
    expect(new Set(labels).size).toBe(60);
    for (const l of labels) expect(l.startsWith('Project '), `en: ${l}`).toBe(true);
    expect(floorLabel('ipe')).toBe('Project Ipê');
    expect(floorLabel('carvalho')).toBe('Project Oak');
  });

  it('unknown id (from a newer server version) falls back to "Project"', () => {
    expect(isFloorNameId('ipe')).toBe(true);
    expect(isFloorNameId('novo')).toBe(false);
    expect(floorLabel('novo')).toBe('Project');
  });
});
