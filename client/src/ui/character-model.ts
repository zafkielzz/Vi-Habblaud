// Character editor, pure logic (no DOM): when drawer offers editing, how parts are grouped,
// labels, and what goes to server in `parts`. The UI lives in character-editor.ts.
import { PART_KEYS, type AppearanceParts, type PartKey } from '../../../shared/appearance';
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo } from '../../../shared/types';
import type { Appearance } from '../art/api';
import { tr } from '../../../shared/i18n';

export interface EditGate {
  /** Agent is still in the office. */
  live: boolean;
  /** meta.terminal: Habblaud only accessible from local computer (local bind). */
  terminal: boolean;
  /** Page opened via localhost/127.x (server rejects others). */
  local: boolean;
  replaying: boolean;
  mock: boolean;
}

/**
 * Does "Edit character" pencil appear? Only for real, live main agent not leaving (offline: server
 * would reply 404) and with local access (terminal restriction).
 */
export function canEditCharacter(a: Pick<AgentInfo, 'id' | 'kind' | 'status'>, g: EditGate): boolean {
  return a.kind === 'main' && a.status !== 'offline' && g.live && g.terminal && g.local && !g.replaying && !g.mock && !isDemoId(a.id);
}

/** Parts differing from seed-generated base appearance (sent in `parts`), in PART_KEYS order. */
export function changedParts(base: Appearance, edited: Appearance): AppearanceParts {
  const out: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = edited[k];
    if (v !== undefined && v !== base[k]) out[k] = v;
  }
  return out as AppearanceParts;
}

export interface EditorRow {
  key: PartKey;
  label: string;
  kind: 'style' | 'color';
}

export const EDITOR_GROUPS: readonly { title: string; rows: readonly EditorRow[] }[] = [
  { title: tr('Skin'), rows: [{ key: 'skin', label: tr('Tone'), kind: 'color' }] },
  {
    title: tr('Hair'),
    rows: [
      { key: 'hairStyle', label: tr('Style'), kind: 'style' },
      { key: 'hair', label: tr('Color'), kind: 'color' },
    ],
  },
  { title: tr('Beard'), rows: [{ key: 'facialHair', label: tr('Style'), kind: 'style' }] },
  { title: tr('Eyes'), rows: [{ key: 'eyes', label: tr('Color'), kind: 'color' }] },
  {
    title: tr('Top'),
    rows: [
      { key: 'topStyle', label: tr('Style'), kind: 'style' },
      { key: 'top', label: tr('Color'), kind: 'color' },
      { key: 'topAccent', label: tr('Detail'), kind: 'color' },
    ],
  },
  {
    title: tr('Bottom'),
    rows: [
      { key: 'bottomStyle', label: tr('Style'), kind: 'style' },
      { key: 'bottom', label: tr('Color'), kind: 'color' },
    ],
  },
  { title: tr('Shoes'), rows: [{ key: 'shoes', label: tr('Color'), kind: 'color' }] },
  {
    title: tr('Accessory'),
    rows: [
      { key: 'accessory', label: tr('Type'), kind: 'style' },
      { key: 'accessoryColor', label: tr('Color'), kind: 'color' },
    ],
  },
];

const STYLE_LABELS: Partial<Record<PartKey, Readonly<Record<string, string>>>> = {
  hairStyle: {
    short: tr('Short'), buzz: tr('Buzz cut'), spiky: tr('Spiky'), side_part: tr('Side part'), curly: tr('Curly'), afro: tr('Afro'),
    bob: tr('Bob'), long: tr('Long'), ponytail: tr('Ponytail'), bun: tr('Bun'), pigtails: tr('Pigtails'), mohawk: tr('Mohawk'),
    bald: tr('Bald'), wavy: tr('Wavy'),
  },
  topStyle: {
    tshirt: tr('T-shirt'), hoodie: tr('Hoodie'), shirt_tie: tr('Shirt and tie'), sweater: tr('Sweater'), jacket: tr('Jacket'),
    blouse: tr('Blouse'), polo: 'Polo',
  },
  bottomStyle: { pants: tr('Pants'), shorts: tr('Shorts'), skirt: tr('Skirt') },
  accessory: {
    none: tr('None'), glasses: tr('Glasses'), sunglasses: tr('Sunglasses'), headphones: tr('Headphones'), cap: tr('Cap'), beanie: tr('Beanie'),
    earrings: tr('Earrings'), bow: tr('Bow'),
  },
  facialHair: { none: tr('No beard'), stubble: tr('Stubble'), beard: tr('Beard'), mustache: tr('Mustache'), goatee: tr('Goatee') },
};

/** Label for a style (hair, clothes, accessory...). */
export function styleLabel(key: PartKey, value: string): string {
  return STYLE_LABELS[key]?.[value] ?? value;
}

/** Does row appear for this appearance? (without accessory, no accessory color to pick). */
export function rowVisible(r: EditorRow, a: Pick<Appearance, 'accessory'>): boolean {
  return !(r.key === 'accessoryColor' && a.accessory === 'none');
}
