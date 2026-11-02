// In the browser, instead of locales/all.ts (see vite.config.ts): the active language's dictionary arrives through a
// dynamic import in client/src/main.ts.
import type { Locale } from '../i18n';

export const DICTIONARIES: Partial<Record<Locale, Readonly<Record<string, string>>>> = {};
