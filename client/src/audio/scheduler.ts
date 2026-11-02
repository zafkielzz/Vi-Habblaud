// Sound scheduler (pure): decides if a sound plays now and at what volume, according to preferences
// (master on/off, master volume, categories), tab visibility, and rate limits.
import type { SoundCueKind } from '../world/api';

/** Categories that the user toggles in settings. */
export type SoundCategory = 'alerts' | 'keys' | 'elevator' | 'social';
/** Sounds: the "needs you" chime, task completion pop, and ambient cues. */
export type SoundKind = 'chime' | 'pop' | SoundCueKind;

export const SOUND_CATEGORIES: readonly SoundCategory[] = ['alerts', 'keys', 'elevator', 'social'];

export const CATEGORY_OF: Readonly<Record<SoundKind, SoundCategory>> = {
  chime: 'alerts',
  pop: 'alerts',
  keys: 'keys',
  elevator: 'elevator',
  pingpong: 'social',
  table: 'social',
  arcade: 'social',
};

/** Minimum interval (ms) between two sounds on the same channel. */
export const MIN_GAP_MS: Readonly<Record<SoundKind, number>> = {
  chime: 1_200,
  pop: 1_200,
  keys: 600,
  elevator: 1_500,
  pingpong: 200,
  table: 200,
  arcade: 450,
};

/** Chime and pop share the same channel (one does not step on the other). */
const CHANNEL: Readonly<Record<SoundKind, string>> = {
  chime: 'alerts',
  pop: 'alerts',
  keys: 'keys',
  elevator: 'elevator',
  pingpong: 'pingpong',
  table: 'pingpong',
  arcade: 'arcade',
};

/** Global ceiling: at most this many sounds per second (alert chime always passes). */
export const MAX_PER_SECOND = 7;

export interface SoundSettings {
  /** Master volume (0–1). */
  volume: number;
  alerts: boolean;
  keys: boolean;
  elevator: boolean;
  social: boolean;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { volume: 0.6, alerts: true, keys: true, elevator: true, social: true };

/** Validates field by field (corrupted preference falls back to default). */
export function sanitizeSoundSettings(raw: unknown): SoundSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SOUND_SETTINGS;
  const bool = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);
  const vol = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : d.volume;
  return { volume: vol, alerts: bool(o.alerts, d.alerts), keys: bool(o.keys, d.keys), elevator: bool(o.elevator, d.elevator), social: bool(o.social, d.social) };
}

/** Master volume curve: keeps the slider perceptually linear. */
export function masterGain(volume: number): number {
  const v = Math.min(1, Math.max(0, volume));
  return v * v;
}

export class SoundScheduler {
  private enabled = false;
  private settings: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };
  private last = new Map<string, number>();
  private recent: number[] = [];

  configure(enabled: boolean, settings: SoundSettings): void {
    this.enabled = enabled;
    this.settings = settings;
  }

  /** Is the sound allowed by preferences (master, category, and volume)? */
  allowed(kind: SoundKind): boolean {
    return this.enabled && this.settings.volume > 0 && this.settings[CATEGORY_OF[kind]];
  }

  /**
   * Final gain (0–1) to play `kind` now, or null if it should not play. In a hidden tab only
   * the "needs you" chime plays. `gain` is the proximity suggested by the world.
   */
  decide(kind: SoundKind, now: number, opts: { hidden?: boolean; gain?: number } = {}): number | null {
    if (!this.allowed(kind)) return null;
    if (opts.hidden && kind !== 'chime') return null;
    const ch = CHANNEL[kind];
    const prev = this.last.get(ch);
    if (prev !== undefined && now - prev < MIN_GAP_MS[kind]) return null;
    while (this.recent.length && now - this.recent[0] >= 1_000) this.recent.shift();
    if (kind !== 'chime' && this.recent.length >= MAX_PER_SECOND) return null;
    const g = masterGain(this.settings.volume) * Math.min(1, Math.max(0, opts.gain ?? 1));
    if (g <= 0.0005) return null;
    this.last.set(ch, now);
    this.recent.push(now);
    return g;
  }
}
