// UI languages. English is the source language: every text is written in English and goes through tr(), which
// returns the translation for the active language or, when there is none, the English text itself.
// An incomplete translation therefore never breaks the interface.
//
// Language choice (once, when this module loads):
// - browser: saved preference (Settings > Language), otherwise the browser languages;
// - server: HABBLAUD_LANG, otherwise the system language (LC_ALL / LC_MESSAGES / LANG / Intl).
// Activity texts are built by the server, so they follow the server language.
import { DICTIONARIES } from './locales/all';

export type Locale = 'en' | 'vi';

/** In selector order; each language name is written in that language, for whoever can't read the current one. */
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'vi', name: 'Tiếng Việt' },
];

/** Key of the preference saved in the browser. */
export const LOCALE_STORAGE_KEY = 'habblaud:locale';

/** Available dictionaries (none for English: it is the source language). Empty in the browser: see registerDictionary. */
const DICTS: Partial<Record<Locale, Readonly<Record<string, string>>>> = { ...DICTIONARIES };

/** The browser loads only the active language's dictionary and registers it here before building the interface. */
export function registerDictionary(l: Locale, dict: Readonly<Record<string, string>>): void {
  DICTS[l] = dict;
}

/** "vi-VN", "vi_VN.UTF-8", "en", "en_US"... -> supported language; undefined if it is none of them. */
export function normalizeLocale(v: string | null | undefined): Locale | undefined {
  const s = (v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return undefined;
  if (s === 'vi' || s.startsWith('vi-')) return 'vi';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return undefined;
}

/**
 * Server language (activities, notices, logs): HABBLAUD_LANG, then the system (LC_ALL, LC_MESSAGES, LANG and, last,
 * Intl); anything that isn't Vietnamese means English.
 */
export function serverLocale(env: Record<string, string | undefined>, intl?: string): Locale {
  const own = normalizeLocale(env.HABBLAUD_LANG);
  if (own) return own;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG, intl]) {
    const n = normalizeLocale(v);
    if (n) return n;
  }
  return 'en';
}

function detect(): Locale {
  const g = globalThis as {
    window?: unknown;
    localStorage?: { getItem(k: string): string | null };
    navigator?: { languages?: readonly string[]; language?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.window !== undefined) {
    try {
      const saved = normalizeLocale(g.localStorage?.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // localStorage blocked (private mode, iframe): fall back to the browser languages.
    }
    for (const l of g.navigator?.languages ?? [g.navigator?.language ?? '']) {
      const n = normalizeLocale(l);
      if (n) return n;
    }
    return 'en';
  }
  const env = g.process?.env ?? {};
  // Tests compare English texts: they stay in English even on a machine set to another language.
  if (env.VITEST) return normalizeLocale(env.HABBLAUD_LANG_TEST) ?? 'en';
  let intl: string | undefined;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    intl = undefined;
  }
  return serverLocale(env, intl);
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

/** Changes the active language (tests; in the browser, changing it in the interface reloads the page). */
export function setLocale(l: Locale): void {
  current = l;
}

/**
 * Translates an English text. Numbered placeholders ({0}, {1}...) get `args` in order; the translation may reorder
 * them. Without a translation for the active language, returns the original text.
 */
export function tr(src: string, args?: readonly unknown[]): string {
  const dict = DICTS[current];
  const s = (dict && dict[src]) || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Language in Intl format (dates, numbers). */
export function intlLocale(): string {
  return current === 'vi' ? 'vi-VN' : 'en-US';
}
