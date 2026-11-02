// Appearance parts selectable in the character editor: style lists, validation of API inputs, and a stable
// signature. Palettes and combination rules live in art (client/src/art/character/appearance.ts, editorOptions);
// only the format is here. Pure: no Node or DOM.

export const HAIR_STYLES = [
  'short', 'buzz', 'spiky', 'side_part', 'curly', 'afro', 'bob', 'long', 'ponytail', 'bun', 'pigtails', 'mohawk', 'bald', 'wavy',
] as const;
export const TOP_STYLES = ['tshirt', 'hoodie', 'shirt_tie', 'sweater', 'jacket', 'blouse', 'polo'] as const;
export const ACCESSORIES = ['none', 'glasses', 'sunglasses', 'headphones', 'cap', 'beanie', 'earrings', 'bow'] as const;
export const FACIAL_HAIR = ['none', 'stubble', 'beard', 'mustache', 'goatee'] as const;
export const BOTTOM_STYLES = ['pants', 'shorts', 'skirt'] as const;

/** Parts chosen in the editor, applied on top of the appearance drawn from `seed`. Colors in `#rrggbb`. */
export interface AppearanceParts {
  skin?: string;
  hair?: string;
  hairStyle?: (typeof HAIR_STYLES)[number];
  eyes?: string;
  top?: string;
  topAccent?: string;
  topStyle?: (typeof TOP_STYLES)[number];
  bottom?: string;
  bottomStyle?: (typeof BOTTOM_STYLES)[number];
  shoes?: string;
  accessory?: (typeof ACCESSORIES)[number];
  accessoryColor?: string;
  facialHair?: (typeof FACIAL_HAIR)[number];
}

/**
 * Fixed order of parts: same in parseAppearanceParts, partsKey, and editor (changedParts). Timelapse compares
 * by JSON, so order must be stable.
 */
export const PART_KEYS = [
  'skin', 'hair', 'hairStyle', 'eyes', 'top', 'topAccent', 'topStyle', 'bottom', 'bottomStyle', 'shoes', 'accessory',
  'accessoryColor', 'facialHair',
] as const satisfies readonly (keyof AppearanceParts)[];
export type PartKey = (typeof PART_KEYS)[number];

const STYLE_VALUES: Partial<Record<PartKey, readonly string[]>> = {
  hairStyle: HAIR_STYLES,
  topStyle: TOP_STYLES,
  bottomStyle: BOTTOM_STYLES,
  accessory: ACCESSORIES,
  facialHair: FACIAL_HAIR,
};
const COLOR = /^#[0-9a-f]{6}$/i;
// Control (C0/C1), line/paragraph separators (U+2028/2029), and text direction marks (U+200E/200F, U+202A–202E,
// U+2066–2069): names could be disguised with them.
const CONTROL = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export const NAME_MAX = 24;

/** Valid parts in PART_KEYS order (colors in lowercase), or null if anything is out of format. */
export function parseAppearanceParts(raw: unknown): AppearanceParts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) if (!(PART_KEYS as readonly string[]).includes(k)) return null;
  const out: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    const allowed = STYLE_VALUES[k];
    if (allowed ? !allowed.includes(v) : !COLOR.test(v)) return null;
    out[k] = allowed ? v : v.toLowerCase();
  }
  return out as AppearanceParts;
}

/** Character name: NFC, no extra whitespace, 1 to NAME_MAX characters, and no control characters. */
export function parseCharacterName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name || CONTROL.test(name) || [...name].length > NAME_MAX) return null;
  return name;
}

/** Appearance seed: 32-bit unsigned integer. */
export function parseSeed(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 0xffffffff ? raw : null;
}

/** Key to compare names: "ana" and "Ana" (or "Júlia" in NFD and NFC) are the same name. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('pt-BR');
}

/** Stable signature of `parts` (avatar caching and change detection). */
export function partsKey(parts: AppearanceParts | undefined): string {
  return parts ? PART_KEYS.map((k) => parts[k] ?? '').join(',') : '';
}
