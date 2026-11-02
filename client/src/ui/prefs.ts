// UI preferences, persisted in localStorage ('habblaud:prefs').
// Pure: storage is injected (testable in node).
import { DEFAULT_SOUND_SETTINGS, sanitizeSoundSettings, type SoundSettings } from '../audio/scheduler';
import type { DaylightMode, WorldOptions } from '../world/api';
import { DEFAULT_WORLD_OPTIONS } from '../world/api';

export const PREFS_KEY = 'habblaud:prefs';

export interface UiPrefs {
  showNames: boolean;
  bubbles: WorldOptions['bubbles'];
  liveliness: WorldOptions['liveliness'];
  /** Day/night cycle: automatic (local time), always day, or always night. */
  daylight: DaylightMode;
  theme: NonNullable<WorldOptions['theme']>;
  /** Synthesized sounds (master switch; off by default). */
  sound: boolean;
  /** Master volume and sound categories. */
  sounds: SoundSettings;
  /** Browser Notification for alerts when the tab is hidden. */
  browserNotifications: boolean;
  sidebarOpen: boolean;
  feedOpen: boolean;
  /** Hidden accounts in the sidebar (AccountInfo.id). */
  hiddenAccounts: string[];
  /** Habblaud World: notice when the first visitor enters your building (per connection). Enabled by default. */
  worldVisitNotify: boolean;
}

export const DEFAULT_PREFS: UiPrefs = {
  showNames: DEFAULT_WORLD_OPTIONS.showNames,
  bubbles: DEFAULT_WORLD_OPTIONS.bubbles,
  liveliness: DEFAULT_WORLD_OPTIONS.liveliness,
  daylight: 'auto',
  theme: 'auto',
  sound: false,
  sounds: DEFAULT_SOUND_SETTINGS,
  browserNotifications: false,
  sidebarOpen: true,
  feedOpen: true,
  hiddenAccounts: [],
  worldVisitNotify: true,
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Validates field by field: unknown or corrupted values fall back to defaults. */
export function sanitizePrefs(raw: unknown): UiPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFS;
  return {
    showNames: bool(o.showNames, d.showNames),
    bubbles: oneOf(o.bubbles, ['all', 'important', 'none'] as const, d.bubbles),
    liveliness: oneOf(o.liveliness, ['calm', 'normal', 'lively'] as const, d.liveliness),
    // legacy preferences: disabled "day and night" toggle becomes "always day"
    daylight: oneOf(o.daylight, ['auto', 'day', 'night'] as const, o.dayNight === false ? 'day' : d.daylight),
    theme: oneOf(o.theme, ['auto', 'none', 'christmas', 'halloween'] as const, d.theme),
    sound: bool(o.sound, d.sound),
    sounds: sanitizeSoundSettings(o.sounds),
    browserNotifications: bool(o.browserNotifications, d.browserNotifications),
    sidebarOpen: bool(o.sidebarOpen, d.sidebarOpen),
    feedOpen: bool(o.feedOpen, d.feedOpen),
    // The account filter chips are gone: a list saved by them would hide accounts with no way back.
    hiddenAccounts: [],
    worldVisitNotify: bool(o.worldVisitNotify, d.worldVisitNotify),
  };
}

export function loadPrefs(storage: StorageLike | null): UiPrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(PREFS_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage: StorageLike | null, prefs: UiPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked (incognito tab): preferences apply only to this session.
  }
}

/** Preferences subset consumed by the world (canvas). */
export function worldOptionsFrom(p: UiPrefs): Partial<WorldOptions> {
  return { showNames: p.showNames, bubbles: p.bubbles, liveliness: p.liveliness, dayNight: p.daylight !== 'day', daylight: p.daylight, theme: p.theme };
}

/** localStorage with protection against browsers that throw an exception when accessing it. */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Migration from legacy name (CodeTown, up to 0.3.2): keys were `codetown:prefs`,
 * `codetown:update-seen`, `codetown.wallets.v1`... and now start with `habblaud`.
 */
const LEGACY_NAME = 'codetown';
const LEGACY_PREFIXES = [`${LEGACY_NAME}:`, `${LEGACY_NAME}.`];
const NAME = 'habblaud';

type ListableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * Renames legacy keys so upgrading users don't lose preferences or coins.
 * Runs on boot, before any reads. If the new key already exists, it takes precedence and the old one is deleted.
 * Returns how many keys were copied.
 */
export function migrateLegacyKeys(storage: ListableStorage | null): number {
  if (!storage) return 0;
  const legacy: string[] = [];
  try {
    // List before modifying: deleting during iteration changes key(i) indices.
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && LEGACY_PREFIXES.some((p) => key.startsWith(p))) legacy.push(key);
    }
  } catch {
    return 0;
  }
  let copied = 0;
  for (const old of legacy) {
    try {
      const value = storage.getItem(old);
      const key = NAME + old.slice(LEGACY_NAME.length);
      if (value !== null && storage.getItem(key) === null) {
        storage.setItem(key, value);
        copied++;
      }
      // Only delete after copying: if writing fails (quota full), the old key remains for next time.
      storage.removeItem(old);
    } catch {
      // continue with other keys
    }
  }
  return copied;
}
