// All dictionaries at once: the server, scripts and tests use this module. In the browser, vite.config.ts swaps it for
// locales/none.ts, and the client loads only the active language's dictionary (client/src/main.ts).
import type { Locale } from '../i18n';
import { VI } from './vi';

export const DICTIONARIES: Partial<Record<Locale, Readonly<Record<string, string>>>> = { vi: VI };
