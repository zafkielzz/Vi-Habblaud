import { describe, expect, it } from 'vitest';
import { parsePlayerName, playerNameKey, type PlayerNameProblem } from './names-rules';
import { RESERVED_PLAYER_NAMES } from './protocol';

const ok = (raw: unknown) => {
  const r = parsePlayerName(raw);
  if (!r.ok) throw new Error(`rejected (${r.problem}): ${JSON.stringify(raw)}`);
  return r;
};
const problem = (raw: unknown): PlayerNameProblem | undefined => {
  const r = parsePlayerName(raw);
  return r.ok ? undefined : r.problem;
};

describe('parsePlayerName', () => {
  it('accepts common names and collapses spaces (trim and repeated)', () => {
    expect(ok('Ana')).toEqual({ ok: true, name: 'Ana', key: 'ana' });
    expect(ok('  Márcio   Jr  ')).toEqual({ ok: true, name: 'Márcio Jr', key: 'marcio jr' });
    expect(ok('dev_ninja-42.x').name).toBe('dev_ninja-42.x');
  });

  it('accents: NFC before counting, and decomposed becomes precomposed', () => {
    const r = ok('Márcio');
    expect(r.name).toBe('Márcio');
    expect(r.name).toBe('Márcio'.normalize('NFC'));
    expect(r.key).toBe('marcio');
    expect(ok('Ñandú João Ü').key).toBe('nandu joao u');
  });

  it('length: 3 to 20 characters (code points), after cleaning', () => {
    expect(problem('Al')).toBe('length');
    expect(problem('  Al   ')).toBe('length');
    expect(ok('Ali').name).toBe('Ali');
    expect(ok('a'.repeat(20)).name).toHaveLength(20);
    expect(problem('a'.repeat(21))).toBe('length');
    expect(problem('a'.repeat(10_000))).toBe('length');
    // Non-BMP letters count as one (not two code units).
    expect(ok('𝒜𝒷𝒸').name).toBe('𝒜𝒷𝒸');
  });

  it('rejects invisibles, control chars, direction marks, and special spaces', () => {
    const cases = [
      'Ana​', // zero-width space
      'A‍na', // ZWJ
      'A‌na', // ZWNJ
      'Ana‮txt', // reverse direction
      'Ana‏txt', // RTL mark
      'ㅤㅤㅤ', // Hangul filler (blank letter)
      'Anaﾠ', // halfwidth Hangul filler
      'An a', // non-breaking space
      'An　a', // ideographic space
      'An\ta', // tab
      'An\na', // newline
      'Ana️', // variation selector
      'Ana­', // soft hyphen
      'Ana\u0007', // control
      'Ana', // private use
    ];
    for (const c of cases) expect(problem(c), JSON.stringify(c)).toBe('invisible');
  });

  it('rejects characters outside the allowed list and stacked accents', () => {
    for (const c of ['Ana!', 'Ana😀', 'ana@x', 'a/b/c', 'Ana٣', 'Ana４', '<b>oi</b>', '⠀⠀⠀']) {
      expect(problem(c), c).toBe('chars');
    }
    // Stray accent at start and "zalgo".
    expect(problem('́Ana')).toBe('chars');
    expect(problem('Aná̂̃̄̅')).toBe('chars'); // NFC combines the first; 4 remain
    expect(ok('Aná̂̃̄').name).toHaveLength(6); // 3 remaining still pass
    expect(ok('กี้ไทย').name).toBe('กี้ไทย'); // Thai: 2 consecutive marks is normal
  });

  it('single script only (Japanese, Korean, and Chinese count as one)', () => {
    expect(problem('Pаulo')).toBe('scripts'); // Cyrillic "а" inside Latin
    expect(problem('Ana山')).toBe('scripts');
    expect(problem('Иван Smith')).toBe('scripts');
    for (const name of ['Παύλος', 'Иван', 'محمد', 'דוד', 'राहुल', '山田たろう', 'カタカナー', '김민수', '한국漢字', '王小明']) {
      expect(ok(name).name, name).toBe(name);
    }
    // Digits and separators do not count as a script.
    expect(ok('Иван_2000').name).toBe('Иван_2000');
  });

  it('requires at least one letter', () => {
    expect(problem('123')).toBe('no_letter');
    expect(problem('...')).toBe('no_letter');
    expect(problem('_-_')).toBe('no_letter');
  });

  it('reserved names become name_blocked, compared by key without separators', () => {
    for (const name of RESERVED_PLAYER_NAMES) {
      const r = parsePlayerName(name.toUpperCase());
      expect(r, name).toEqual({ ok: false, code: 'name_blocked', problem: 'reserved' });
    }
    for (const name of ['Ad.Min', 'ad_min', 'Clàude', 'C L A U D E', 'ＡＤＭＩＮ']) expect(problem(name), name).toBe('reserved');
    expect(ok('Administradora').name).toBe('Administradora');
    expect(ok('Claudete').name).toBe('Claudete');
  });

  it('the rest results in name_invalid; non-strings too', () => {
    expect(parsePlayerName(42)).toEqual({ ok: false, code: 'name_invalid', problem: 'type' });
    expect(parsePlayerName(undefined)).toMatchObject({ ok: false, code: 'name_invalid' });
    expect(parsePlayerName('A!b')).toMatchObject({ ok: false, code: 'name_invalid' });
  });
});

describe('playerNameKey', () => {
  it('NFKC, lowercase, stripped diacritics, and collapsed spaces', () => {
    expect(playerNameKey('Márcio')).toBe('marcio');
    expect(playerNameKey('MARCIO')).toBe('marcio');
    expect(playerNameKey('ｍａｒｃｉｏ')).toBe('marcio');
    expect(playerNameKey('  Mar   cio ')).toBe('mar cio');
    expect(playerNameKey('Márcio')).toBe(playerNameKey('Márcio'));
    expect(playerNameKey('Çağrı')).toBe('cagrı');
    expect(playerNameKey('Ἀθηνᾶ')).toBe('αθηνα');
  });

  it('truly different names remain different', () => {
    expect(playerNameKey('Ana')).not.toBe(playerNameKey('Anna'));
    expect(playerNameKey('Pаulo')).not.toBe(playerNameKey('Paulo')); // Cyrillic "а" (rejected earlier anyway)
  });
});
