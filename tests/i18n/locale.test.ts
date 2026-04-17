// tests/i18n/locale.test.ts — SPEC-854 unit tests: detectLocale, setLocale, t(), tLocale()

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectLocale, setLocale, normalizeLocale, __resetLocaleCache, currentLocale } from '../../src/i18n/locale.ts';
import { t, tLocale, initI18n, __resetBundleCache, loadBundle } from '../../src/i18n/format.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

const origLang = process.env['LANG'];
const origLanguage = process.env['LANGUAGE'];
const origLcAll = process.env['LC_ALL'];

function setEnv(lang?: string, language?: string, lcAll?: string): void {
  if (lang === undefined) delete process.env['LANG'];
  else process.env['LANG'] = lang;
  if (language === undefined) delete process.env['LANGUAGE'];
  else process.env['LANGUAGE'] = language;
  if (lcAll === undefined) delete process.env['LC_ALL'];
  else process.env['LC_ALL'] = lcAll;
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  __resetLocaleCache();
  __resetBundleCache();
  delete process.env['LANG'];
  delete process.env['LANGUAGE'];
  delete process.env['LC_ALL'];
});

afterEach(() => {
  if (origLang !== undefined) process.env['LANG'] = origLang;
  else delete process.env['LANG'];
  if (origLanguage !== undefined) process.env['LANGUAGE'] = origLanguage;
  else delete process.env['LANGUAGE'];
  if (origLcAll !== undefined) process.env['LC_ALL'] = origLcAll;
  else delete process.env['LC_ALL'];
  __resetLocaleCache();
  __resetBundleCache();
});

// ── SPEC-854 T1 — detectLocale ─────────────────────────────────────────────

describe('SPEC-854: detectLocale', () => {
  test('LANG=vi_VN.UTF-8 → vi', () => {
    setEnv('vi_VN.UTF-8');
    expect(detectLocale()).toBe('vi');
  });

  test('LANG=en_US.UTF-8 → en', () => {
    setEnv('en_US.UTF-8');
    expect(detectLocale()).toBe('en');
  });

  test('LANG=fr_FR.UTF-8 (unsupported) → en fallback', () => {
    setEnv('fr_FR.UTF-8');
    expect(detectLocale()).toBe('en');
  });

  test('no env vars → default en', () => {
    setEnv();
    expect(detectLocale()).toBe('en');
  });

  test('LANGUAGE=vi:en when LANG absent → vi', () => {
    setEnv(undefined, 'vi:en');
    expect(detectLocale()).toBe('vi');
  });

  test('workspaceLocale=vi overrides LANG=en', () => {
    setEnv('en_US.UTF-8');
    expect(detectLocale('vi')).toBe('vi');
  });

  test('workspaceLocale=en overrides LANG=vi', () => {
    setEnv('vi_VN.UTF-8');
    expect(detectLocale('en')).toBe('en');
  });
});

// ── SPEC-854 T2 — setLocale (session override) ────────────────────────────

describe('SPEC-854: setLocale session override', () => {
  test('setLocale vi → currentLocale returns vi', () => {
    setLocale('vi');
    expect(currentLocale()).toBe('vi');
  });

  test('setLocale en → currentLocale returns en', () => {
    setLocale('en');
    expect(currentLocale()).toBe('en');
  });

  test('setLocale vi → t() uses vi bundle', () => {
    initI18n('vi');
    setLocale('vi');
    const result = t('errors.P_NETWORK');
    expect(result).toContain('mạng');
  });

  test('setLocale en → t() uses en bundle', () => {
    initI18n('vi');
    setLocale('vi');
    setLocale('en');
    const result = t('errors.P_NETWORK');
    expect(result).toContain('Network error');
  });
});

// ── SPEC-854 T3 — tLocale (explicit locale) ───────────────────────────────

describe('SPEC-854: tLocale(key, locale)', () => {
  test('tLocale vi returns Vietnamese string', () => {
    const result = tLocale('errors.P_NETWORK', 'vi');
    expect(result).toContain('mạng');
  });

  test('tLocale en returns English string', () => {
    const result = tLocale('errors.P_NETWORK', 'en');
    expect(result).toContain('Network error');
  });

  test('tLocale: missing vi key falls back to en', () => {
    // Temporarily remove a key from vi bundle
    const vi = loadBundle('vi');
    vi.messages.delete('errors.P_NETWORK');
    const result = tLocale('errors.P_NETWORK', 'vi');
    expect(result).toContain('Network error');
  });

  test('tLocale: unknown key falls back to key string', () => {
    const result = tLocale('unknown.key.xyz', 'en');
    expect(result).toBe('unknown.key.xyz');
  });

  test('tLocale: unknown key in vi falls back to key string', () => {
    const result = tLocale('totally.missing', 'vi');
    expect(result).toBe('totally.missing');
  });

  test('tLocale with interpolation', () => {
    const result = tLocale('errors.T_CRASH', 'en', { detail: 'test error' });
    expect(result).toContain('test error');
  });
});

// ── SPEC-854 T4 — New message bundle keys ────────────────────────────────

describe('SPEC-854: new key bundles (cli.help.*, check.*, doctor.*, error.*, locale.*)', () => {
  test('cli.help.title exists in en', () => {
    const en = loadBundle('en');
    expect(en.messages.has('cli.help.title')).toBe(true);
    expect(en.messages.get('cli.help.title')).toContain('nimbus');
  });

  test('cli.help.title exists in vi', () => {
    const vi = loadBundle('vi');
    expect(vi.messages.has('cli.help.title')).toBe(true);
  });

  test('check.all_ok en is not bare Vietnamese', () => {
    const en = loadBundle('en');
    const val = en.messages.get('check.all_ok') ?? '';
    expect(val).not.toMatch(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/);
  });

  test('check.all_ok vi is Vietnamese', () => {
    const vi = loadBundle('vi');
    const val = vi.messages.get('check.all_ok') ?? '';
    expect(val.length).toBeGreaterThan(0);
    // Verify it is NOT the English string
    const en = loadBundle('en');
    expect(val).not.toBe(en.messages.get('check.all_ok'));
  });

  test('error.ui_busy exists in both locales', () => {
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    expect(en.messages.has('error.ui_busy')).toBe(true);
    expect(vi.messages.has('error.ui_busy')).toBe(true);
  });

  test('error.keybind_reserved exists in both locales', () => {
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    expect(en.messages.has('error.keybind_reserved')).toBe(true);
    expect(vi.messages.has('error.keybind_reserved')).toBe(true);
  });

  test('error.operation_denied exists in both locales', () => {
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    expect(en.messages.has('error.operation_denied')).toBe(true);
    expect(vi.messages.has('error.operation_denied')).toBe(true);
  });

  test('locale.set key with interpolation works', () => {
    const result = tLocale('locale.set', 'en', { locale: 'vi' });
    expect(result).toContain('vi');
  });

  test('locale.set key in vi works', () => {
    const result = tLocale('locale.set', 'vi', { locale: 'vi' });
    expect(result).toContain('vi');
  });

  test('en and vi bundles have same set of SPEC-854 keys', () => {
    const newKeys = [
      'cli.help.title', 'cli.help.usage', 'cli.help.slash_hint',
      'check.section.system', 'check.section.workspace', 'check.all_ok', 'check.issues_found',
      'doctor.header', 'doctor.all_ok', 'doctor.no_workspace',
      'error.ui_busy', 'error.ui_cancelled', 'error.keybind_reserved', 'error.operation_denied',
      'locale.set', 'locale.invalid', 'locale.current',
    ];
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    for (const key of newKeys) {
      expect(en.messages.has(key)).toBe(true);
      expect(vi.messages.has(key)).toBe(true);
    }
  });
});

// ── SPEC-854 T5 — normalizeLocale edge cases ──────────────────────────────

describe('SPEC-854: normalizeLocale edge cases', () => {
  test('vi (bare) → vi', () => {
    expect(normalizeLocale('vi')).toBe('vi');
  });

  test('VI (uppercase) → vi', () => {
    expect(normalizeLocale('VI')).toBe('vi');
  });

  test('en (bare) → en', () => {
    expect(normalizeLocale('en')).toBe('en');
  });

  test('de → undefined', () => {
    expect(normalizeLocale('de')).toBeUndefined();
  });
});
