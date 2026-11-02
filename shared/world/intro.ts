// Player introduction phrases for Habblaud World: protocol carries only the id (IntroId); text is translated in
// the viewer's browser. Pure: no Node or DOM.
import { tr } from '../i18n';
import { INTRO_IDS, type IntroId } from './protocol';

export { INTRO_IDS, type IntroId };

/** One function per id (tr runs on demand, in active language). The Record requires all ids to be present. */
const LABELS: Readonly<Record<IntroId, () => string>> = {
  night_owl: () => tr('I code late at night'),
  early_bird: () => tr('I get up early to code'),
  coffee: () => tr('Powered by coffee'),
  tea: () => tr('Team tea'),
  tabs: () => tr('Team tabs'),
  spaces: () => tr('Team spaces'),
  dark_mode: () => tr('Dark mode, always'),
  light_mode: () => tr('Light mode, no fear'),
  vim: () => tr('Vim till the end'),
  tests_first: () => tr('I test before I write'),
  ship_fast: () => tr('I ship fast'),
  refactor: () => tr('Refactoring is my hobby'),
  pixel_art: () => tr('Pixel art fan'),
  music: () => tr('I code with music on'),
  silence: () => tr('I code in silence'),
  cats: () => tr('Cat person'),
  dogs: () => tr('Dog person'),
  open_source: () => tr('Open source all the way'),
  learning: () => tr('Always learning'),
  hello: () => tr('Hi, nice to meet you!'),
};

export function isIntroId(v: unknown): v is IntroId {
  return typeof v === 'string' && (INTRO_IDS as readonly string[]).includes(v);
}

/** Phrase text in active language (an id unknown to this version from a newer server falls back to the id itself). */
export function introLabel(id: IntroId): string {
  return LABELS[id]?.() ?? String(id);
}

/** All phrases, in INTRO_IDS order (for the picker). */
export function introOptions(): { id: IntroId; label: string }[] {
  return INTRO_IDS.map((id) => ({ id, label: introLabel(id) }));
}
