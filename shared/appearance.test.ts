import { describe, expect, it } from 'vitest';
import { NAME_MAX, nameKey, parseAppearanceParts, parseCharacterName, parseSeed, partsKey } from './appearance';

describe('parseAppearanceParts', () => {
  it('accepts valid parts, returns in fixed order and lowercase colors', () => {
    const p = parseAppearanceParts({ topStyle: 'jacket', skin: '#D69F78', hairStyle: 'bob' });
    expect(p).toEqual({ skin: '#d69f78', hairStyle: 'bob', topStyle: 'jacket' });
    expect(Object.keys(p!)).toEqual(['skin', 'hairStyle', 'topStyle']);
    expect(parseAppearanceParts({})).toEqual({});
  });

  it('rejects unknown key, invalid enum, color outside #rrggbb, and non-object', () => {
    const bad: unknown[] = [
      null,
      'x',
      1,
      [],
      { lanyard: '#ffffff' },
      { look: 'f' },
      { hairStyle: 'moicano' },
      { skin: '#fff' },
      { skin: 'red' },
      { skin: 1 },
      { accessory: undefined, hair: '#12345g' },
    ];
    for (const b of bad) expect(parseAppearanceParts(b)).toBeNull();
  });
});

describe('parseCharacterName', () => {
  it('trims, collapses spaces (including line breaks), and normalizes to NFC', () => {
    expect(parseCharacterName('  Ana   Paula ')).toBe('Ana Paula');
    expect(parseCharacterName('Ana\nPaula')).toBe('Ana Paula');
    // Purposeful escapes: NFD (u + U+0301) in input and NFC (U+00FA) in expected; an editor would normalize the literal.
    expect(parseCharacterName('Ju\u0301lia')).toBe('J\u00falia');
  });

  it(`1 to ${NAME_MAX} characters (emoji counts as one), without control characters`, () => {
    expect(parseCharacterName('a'.repeat(NAME_MAX))).toBe('a'.repeat(NAME_MAX));
    expect(parseCharacterName('🙂'.repeat(NAME_MAX))).toBe('🙂'.repeat(NAME_MAX));
    for (const bad of ['', '   ', 'a'.repeat(NAME_MAX + 1), 'Ana\u0000', 'Ana\u202e', 'Ana\u0085', 42, null]) {
      expect(parseCharacterName(bad)).toBeNull();
    }
  });
});

describe('nameKey, parseSeed, and partsKey', () => {
  it('nameKey ignores case and Unicode form', () => {
    // Uppercase NFD against lowercase NFC, in escapes (see parseCharacterName test).
    expect(nameKey('JU\u0301LIA')).toBe(nameKey('j\u00falia'));
    expect(nameKey('Ana')).toBe(nameKey('ana'));
    expect(nameKey('Ana')).not.toBe(nameKey('Ána'));
  });

  it('parseSeed: integer from 0 to 2^32-1', () => {
    expect(parseSeed(0)).toBe(0);
    expect(parseSeed(4294967295)).toBe(4294967295);
    for (const bad of [-1, 4294967296, 1.5, '1', Number.NaN, null]) expect(parseSeed(bad)).toBeNull();
  });

  it('partsKey is stable (independent of the order parts were placed)', () => {
    expect(partsKey(undefined)).toBe('');
    expect(partsKey({ hairStyle: 'bob', skin: '#000000' })).toBe(partsKey({ skin: '#000000', hairStyle: 'bob' }));
    expect(partsKey({ skin: '#000000' })).not.toBe(partsKey({ skin: '#000000', hairStyle: 'bob' }));
  });
});
