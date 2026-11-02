// Player name rules for Habblaud World (Phase 1 contract, section 1). Habblaud checks before sending, to
// warn immediately; the world server makes the final call, applying identical rules plus the blocked word list
// (which stays only there). Imports only ./protocol: can be copied as-is to the world server. Pure: no Node or DOM.
//
// The name, after NFC, trim, and collapsing repeated spaces:
// - has 3 to 20 characters (code points);
// - contains only letters, combining marks (at most 3 in a row, after a letter), digits 0-9, space, `_`, `-`, and `.`,
//   with at least one letter;
// - has no control, formatting, direction marks, special spaces, or invisible characters (including those
//   Unicode classifies as letters that render nothing, such as Hangul filler U+3164);
// - uses a single writing system (Latin, Cyrillic, Greek, Arabic...); Japanese (kanji + hiragana + katakana), Korean
//   (hangul + hanja), and Chinese (han + bopomofo) count as one each;
// - is not a reserved name (compared by key, without spaces, `_`, `-`, or `.`).
// The uniqueness key (playerNameKey) equates names that only differ in width, case, accents, or spaces.
import { PLAYER_NAME_LIMITS, RESERVED_PLAYER_NAMES } from './protocol';

/** Why the name was rejected (the server returns only the code; problem is used for local message). */
export type PlayerNameProblem =
  | 'type' // not text
  | 'length' // outside 3 to 20 characters
  | 'invisible' // control, formatting, direction, special space, or invisible
  | 'chars' // character not allowed (or too many stacked accents)
  | 'scripts' // letters from more than one writing system
  | 'no_letter' // no letters
  | 'reserved'; // reserved name

export type PlayerNameResult =
  | { ok: true; name: string; key: string }
  | { ok: false; code: 'name_invalid' | 'name_blocked'; problem: PlayerNameProblem };

/** Consecutive combining marks allowed after a letter (the rest is "zalgo text"). */
const MAX_MARKS = 3;

/**
 * Invisibles and similar: control, formatting, private-use, unassigned (\p{C}), line/paragraph separators,
 * default ignorable code points (ZWJ, variation selectors, Hangul fillers...), and direction marks.
 */
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;
/** Space that is not standard space (NBSP, ideographic space, tab...). */
const ODD_SPACE = /(?! )[\p{Zs}\s]/u;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const OTHER_ALLOWED = /^[0-9 _.-]$/;

/** Recognized writing systems, via Unicode Script_Extensions. */
const SCRIPTS = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar',
  'Georgian', 'Hangul', 'Ethiopic', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han',
] as const;
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp(`^\\p{Script_Extensions=${s}}$`, 'u')] as const);
/** Letter from a script outside the list: allowed alone (two unknown scripts together are not distinguished). */
const OTHER = 'Other';
/** Combinations that count as a single writing system. */
const WRITING_SYSTEMS: readonly (readonly string[])[] = [
  ...SCRIPTS.map((s) => [s]),
  ['Han', 'Hiragana', 'Katakana'],
  ['Hangul', 'Han'],
  ['Han', 'Bopomofo'],
  [OTHER],
];

function scriptsOf(letter: string): string[] {
  const found = SCRIPT_RE.filter(([, re]) => re.test(letter)).map(([s]) => s);
  return found.length ? found : [OTHER];
}

/** Do letters fit into a single writing system? (Each letter may belong to multiple, e.g. Japanese "ー".) */
function oneWritingSystem(letters: readonly string[]): boolean {
  const sets = [...new Set(letters)].map(scriptsOf);
  return WRITING_SYSTEMS.some((system) => sets.every((s) => s.some((x) => system.includes(x))));
}

/** Name trimmed and repeated spaces collapsed (standard space only: others are rejected). */
function tidy(raw: string): string {
  return raw.normalize('NFC').trim().replace(/ {2,}/g, ' ');
}

/**
 * Name uniqueness key: NFKC → lowercase → strip diacritics → collapse spaces. "Márcio", "MARCIO",
 * "ｍａｒｃｉｏ", and "marcio " yield the same key.
 */
export function playerNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{Mn}\p{Me}]/gu, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key without allowed separators (space, `_`, `-`, `.`), to compare against reserved names. */
function compactKey(key: string): string {
  return key.replace(/[ _.-]/g, '');
}

const invalid = (problem: PlayerNameProblem): PlayerNameResult => ({ ok: false, code: 'name_invalid', problem });

/** Validates and tidies player name; returns name to save and its key, or server code and problem. */
export function parsePlayerName(raw: unknown): PlayerNameResult {
  if (typeof raw !== 'string') return invalid('type');
  // Oversized text is not even processed.
  if (raw.length > PLAYER_NAME_LIMITS.max * 8) return invalid('length');
  const name = tidy(raw);
  if (INVISIBLE.test(name) || ODD_SPACE.test(name)) return invalid('invisible');
  const chars = [...name];
  if (chars.length < PLAYER_NAME_LIMITS.min || chars.length > PLAYER_NAME_LIMITS.max) return invalid('length');
  const letters: string[] = [];
  let marks = 0;
  let prevLetter = false;
  for (const ch of chars) {
    if (LETTER.test(ch)) {
      letters.push(ch);
      marks = 0;
      prevLetter = true;
    } else if (MARK.test(ch)) {
      if (!prevLetter || ++marks > MAX_MARKS) return invalid('chars');
    } else if (OTHER_ALLOWED.test(ch)) {
      marks = 0;
      prevLetter = false;
    } else return invalid('chars');
  }
  if (!letters.length) return invalid('no_letter');
  if (!oneWritingSystem(letters)) return invalid('scripts');
  const key = playerNameKey(name);
  if ((RESERVED_PLAYER_NAMES as readonly string[]).includes(compactKey(key))) return { ok: false, code: 'name_blocked', problem: 'reserved' };
  return { ok: true, name, key };
}
