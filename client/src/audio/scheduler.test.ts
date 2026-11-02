// Pure sound scheduler: master preference, categories, volume, hidden tab, and rate limits.
import { describe, expect, it } from 'vitest';
import { CATEGORY_OF, DEFAULT_SOUND_SETTINGS, masterGain, MAX_PER_SECOND, MIN_GAP_MS, sanitizeSoundSettings, SoundScheduler, type SoundKind } from './scheduler';

const on = (patch: Partial<typeof DEFAULT_SOUND_SETTINGS> = {}) => {
  const s = new SoundScheduler();
  s.configure(true, { ...DEFAULT_SOUND_SETTINGS, ...patch });
  return s;
};

describe('sound scheduler', () => {
  it('off by default: nothing plays until turned on', () => {
    const s = new SoundScheduler();
    expect(s.decide('chime', 0)).toBeNull();
    s.configure(true, DEFAULT_SOUND_SETTINGS);
    expect(s.decide('chime', 0)).not.toBeNull();
    s.configure(false, DEFAULT_SOUND_SETTINGS);
    expect(s.decide('chime', 10_000)).toBeNull();
  });

  it('respects disabled categories', () => {
    const s = on({ keys: false, social: false });
    expect(s.decide('keys', 0)).toBeNull();
    expect(s.decide('pingpong', 0)).toBeNull();
    expect(s.decide('table', 0)).toBeNull();
    expect(s.decide('arcade', 0)).toBeNull();
    expect(s.decide('elevator', 0)).not.toBeNull();
    expect(s.decide('chime', 0)).not.toBeNull();
    expect(s.allowed('keys')).toBe(false);
    expect(on({ alerts: false }).decide('pop', 0)).toBeNull();
    // every category exists in the settings
    for (const k of Object.keys(CATEGORY_OF) as SoundKind[]) expect(DEFAULT_SOUND_SETTINGS[CATEGORY_OF[k]]).toBe(true);
  });

  it('master volume: perceptual curve, zero mutes, proximity attenuates', () => {
    expect(masterGain(0)).toBe(0);
    expect(masterGain(1)).toBe(1);
    expect(masterGain(0.5)).toBeCloseTo(0.25);
    expect(masterGain(2)).toBe(1);
    expect(on({ volume: 0 }).decide('chime', 0)).toBeNull();
    expect(on({ volume: 1 }).decide('elevator', 0)).toBe(1);
    expect(on({ volume: 0.5 }).decide('elevator', 0)).toBeCloseTo(0.25);
    expect(on({ volume: 1 }).decide('elevator', 0, { gain: 0.5 })).toBeCloseTo(0.5);
    expect(on({ volume: 1 }).decide('keys', 0, { gain: 7 })).toBe(1);
    expect(on({ volume: 1 }).decide('keys', 0, { gain: 0 })).toBeNull();
  });

  it('rate limit per channel (chime and pop share the same)', () => {
    const s = on();
    expect(s.decide('keys', 1_000)).not.toBeNull();
    expect(s.decide('keys', 1_000 + MIN_GAP_MS.keys - 1)).toBeNull();
    expect(s.decide('keys', 1_000 + MIN_GAP_MS.keys)).not.toBeNull();
    expect(s.decide('chime', 5_000)).not.toBeNull();
    expect(s.decide('pop', 5_500)).toBeNull();
    expect(s.decide('pop', 5_000 + MIN_GAP_MS.chime)).not.toBeNull();
    // paddle and table share the ping-pong channel
    expect(s.decide('pingpong', 9_000)).not.toBeNull();
    expect(s.decide('table', 9_050)).toBeNull();
    expect(s.decide('elevator', 9_050)).not.toBeNull();
  });

  it('global cap of sounds per second (alert chime always passes)', () => {
    const s = on();
    const kinds: SoundKind[] = ['keys', 'elevator', 'pingpong', 'arcade'];
    let played = 0;
    for (let t = 0; t < 1_000; t += 10) for (const k of kinds) if (s.decide(k, t) !== null) played++;
    expect(played).toBeLessThanOrEqual(MAX_PER_SECOND);
    expect(s.decide('chime', 999)).not.toBeNull();
    // after the 1 s window passes, plays again
    expect(s.decide('elevator', 2_600)).not.toBeNull();
  });

  it('with hidden tab, only the "needs you" chime plays', () => {
    const s = on();
    expect(s.decide('pop', 0, { hidden: true })).toBeNull();
    expect(s.decide('keys', 0, { hidden: true })).toBeNull();
    expect(s.decide('elevator', 0, { hidden: true })).toBeNull();
    expect(s.decide('chime', 0, { hidden: true })).not.toBeNull();
  });

  it('a rejected sound does not consume the interval', () => {
    const s = on();
    expect(s.decide('pop', 0, { hidden: true })).toBeNull();
    expect(s.decide('pop', 10)).not.toBeNull();
  });

  it('validates sound settings', () => {
    expect(sanitizeSoundSettings(undefined)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(sanitizeSoundSettings({ volume: 0.3, keys: false })).toEqual({ ...DEFAULT_SOUND_SETTINGS, volume: 0.3, keys: false });
    expect(sanitizeSoundSettings({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND_SETTINGS.volume);
    expect(sanitizeSoundSettings({ volume: 9 }).volume).toBe(1);
  });
});
