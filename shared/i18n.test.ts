import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, intlLocale, normalizeLocale, serverLocale, setLocale, tr } from './i18n';
import { VI } from './locales/vi';

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('tests run in English, whatever the machine language', () => {
    expect(getLocale()).toBe('en');
  });

  it('recognizes the browser and system language formats', () => {
    expect(normalizeLocale('vi')).toBe('vi');
    expect(normalizeLocale('vi-VN')).toBe('vi');
    expect(normalizeLocale('vi_VN.UTF-8')).toBe('vi');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('en_GB.UTF-8')).toBe('en');
    expect(normalizeLocale('pt-BR')).toBeUndefined();
    expect(normalizeLocale('fr')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });

  it('in English returns the text itself, with the placeholders filled', () => {
    expect(tr('Reading {0}', ['app.ts'])).toBe('Reading app.ts');
    expect(tr('Text nobody translated')).toBe('Text nobody translated');
    expect(intlLocale()).toBe('en-US');
  });

  it('in Vietnamese translates and falls back to English', () => {
    setLocale('vi');
    expect(tr('Text nobody translated')).toBe('Text nobody translated');
    expect(intlLocale()).toBe('vi-VN');
  });

  it('placeholders without an argument stay as they are (named ones are filled by the caller)', () => {
    expect(tr('I won {a} to {b}! 🏆')).toBe('I won {a} to {b}! 🏆');
    expect(tr('{0} and {1}', ['one'])).toBe('one and {1}');
  });

  it('server: HABBLAUD_LANG first, then the system; anything but Vietnamese is English', () => {
    expect(serverLocale({ HABBLAUD_LANG: 'en' }, 'vi-VN')).toBe('en');
    expect(serverLocale({ HABBLAUD_LANG: 'vi', LANG: 'en_US.UTF-8' })).toBe('vi');
    expect(serverLocale({ LANG: 'vi_VN.UTF-8' })).toBe('vi');
    expect(serverLocale({ LC_ALL: 'vi_VN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('vi');
    expect(serverLocale({}, 'vi-VN')).toBe('vi');
    expect(serverLocale({ LANG: 'pt_BR.UTF-8' }, 'en-US')).toBe('en');
    expect(serverLocale({}, 'en-US')).toBe('en');
  });

  it('no translation is empty or loses or invents placeholders', () => {
    for (const [en, t] of Object.entries(VI)) {
      expect(t.trim(), en).not.toBe('');
      expect(placeholders(t), `${en} -> ${t}`).toEqual(placeholders(en));
    }
  });
});
