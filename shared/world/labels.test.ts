import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { introLabel, introOptions, isIntroId } from './intro';
import { INTRO_IDS, TRAIT_IDS } from './protocol';
import { isTraitId, parsePlayerTraits, TRAITS, traitsClash } from './traits';

afterEach(() => setLocale('en'));

/** The contract texts for Phase 1. */
const INTRO_EN: Record<string, string> = {
  night_owl: 'I code late at night',
  early_bird: 'I get up early to code',
  coffee: 'Powered by coffee',
  tea: 'Team tea',
  tabs: 'Team tabs',
  spaces: 'Team spaces',
  dark_mode: 'Dark mode, always',
  light_mode: 'Light mode, no fear',
  vim: 'Vim till the end',
  tests_first: 'I test before I write',
  ship_fast: 'I ship fast',
  refactor: 'Refactoring is my hobby',
  pixel_art: 'Pixel art fan',
  music: 'I code with music on',
  silence: 'I code in silence',
  cats: 'Cat person',
  dogs: 'Dog person',
  open_source: 'Open source all the way',
  learning: 'Always learning',
  hello: 'Hi, nice to meet you!',
};

describe('intro phrases', () => {
  it('all 20 ids with contract text', () => {
    expect(Object.keys(INTRO_EN)).toEqual([...INTRO_IDS]);
    for (const id of INTRO_IDS) {
      expect(introLabel(id)).toBe(INTRO_EN[id]);
    }
    expect(introOptions().map((o) => o.id)).toEqual([...INTRO_IDS]);
  });

  it('label follows currently active locale', () => {
    setLocale('en');
    expect(introLabel('coffee')).toBe('Powered by coffee');
  });

  it('unknown id (newer server) falls back to the id itself without breaking', () => {
    expect(introLabel('emacs' as never)).toBe('emacs');
  });

  it('isIntroId', () => {
    expect(isIntroId('vim')).toBe(true);
    expect(isIntroId('emacs')).toBe(false);
    expect(isIntroId(1)).toBe(false);
  });
});

describe('traits', () => {
  it('TRAITS in TRAIT_IDS order (personaFor selection depends on it)', () => {
    expect(Object.keys(TRAITS)).toEqual([...TRAIT_IDS]);
    for (const id of TRAIT_IDS) expect(TRAITS[id].id).toBe(id);
  });

  it('clashing pairs, in both directions', () => {
    expect(traitsClash('timidez', 'piadas')).toBe(true);
    expect(traitsClash('piadas', 'timidez')).toBe(true);
    expect(traitsClash('calma', 'competicao')).toBe(true);
    expect(traitsClash('games', 'leitura')).toBe(false);
  });

  it('player choice: 2 or 3, known, unique, and non-conflicting', () => {
    expect(parsePlayerTraits(['games', 'cafeina'])).toEqual(['games', 'cafeina']);
    expect(parsePlayerTraits(['games', 'cafeina', 'leitura'])).toEqual(['games', 'cafeina', 'leitura']);
    expect(parsePlayerTraits(['games'])).toBeNull();
    expect(parsePlayerTraits(['games', 'cafeina', 'leitura', 'calma'])).toBeNull();
    expect(parsePlayerTraits(['games', 'games'])).toBeNull();
    expect(parsePlayerTraits(['timidez', 'piadas'])).toBeNull();
    expect(parsePlayerTraits(['games', 'xadrez'])).toBeNull();
    expect(parsePlayerTraits('games')).toBeNull();
    expect(isTraitId('sonecas')).toBe(true);
    expect(isTraitId('soneca')).toBe(false);
  });
});
