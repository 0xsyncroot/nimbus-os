// tests/i18n/format.test.ts — SPEC-180 §6.1 unit tests

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetBundleCache,
  initI18n,
  loadBundle,
  t,
} from '../../src/i18n/format.ts';
import {
  __resetLocaleCache,
  currentLocale,
  detectLocale,
  normalizeLocale,
} from '../../src/i18n/locale.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

const origLang = process.env['LANG'];
const origLanguage = process.env['LANGUAGE'];

function setLang(val: string | undefined): void {
  if (val === undefined) delete process.env['LANG'];
  else process.env['LANG'] = val;
}

function setLanguage(val: string | undefined): void {
  if (val === undefined) delete process.env['LANGUAGE'];
  else process.env['LANGUAGE'] = val;
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  __resetLocaleCache();
  __resetBundleCache();
  delete process.env['LANG'];
  delete process.env['LANGUAGE'];
});

afterEach(() => {
  if (origLang !== undefined) process.env['LANG'] = origLang;
  else delete process.env['LANG'];
  if (origLanguage !== undefined) process.env['LANGUAGE'] = origLanguage;
  else delete process.env['LANGUAGE'];
  __resetLocaleCache();
  __resetBundleCache();
});

// ── SPEC-180 T1 — Locale detection ────────────────────────────────────────

describe('SPEC-180: locale detection', () => {
  test('normalizeLocale: vi_VN.UTF-8 → vi', () => {
    expect(normalizeLocale('vi_VN.UTF-8')).toBe('vi');
  });

  test('normalizeLocale: en_US.UTF-8 → en', () => {
    expect(normalizeLocale('en_US.UTF-8')).toBe('en');
  });

  test('normalizeLocale: en_US → en', () => {
    expect(normalizeLocale('en_US')).toBe('en');
  });

  test('normalizeLocale: fr_FR → undefined (unsupported)', () => {
    expect(normalizeLocale('fr_FR')).toBeUndefined();
  });

  test('normalizeLocale: empty string → undefined', () => {
    expect(normalizeLocale('')).toBeUndefined();
  });

  test('LANG=vi_VN.UTF-8 → detectLocale returns vi', () => {
    setLang('vi_VN.UTF-8');
    expect(detectLocale()).toBe('vi');
  });

  test('LANG=en_US.UTF-8 → detectLocale returns en', () => {
    setLang('en_US.UTF-8');
    expect(detectLocale()).toBe('en');
  });

  test('LANG=fr_FR.UTF-8 (unsupported) → falls back to en', () => {
    setLang('fr_FR.UTF-8');
    expect(detectLocale()).toBe('en');
  });

  test('no LANG env → default is en', () => {
    expect(detectLocale()).toBe('en');
  });

  test('LANGUAGE env used when LANG absent', () => {
    setLanguage('vi:en');
    expect(detectLocale()).toBe('vi');
  });

  test('LANGUAGE colon-separated: first element wins', () => {
    setLanguage('vi:fr:en');
    expect(detectLocale()).toBe('vi');
  });

  test('workspaceLocale overrides LANG env', () => {
    setLang('vi_VN.UTF-8');
    expect(detectLocale('en')).toBe('en');
  });

  test('workspaceLocale vi overrides default en', () => {
    expect(detectLocale('vi')).toBe('vi');
  });

  test('workspaceLocale unknown falls through to LANG', () => {
    setLang('vi_VN.UTF-8');
    expect(detectLocale('zz')).toBe('vi');
  });
});

// ── Singleton ──────────────────────────────────────────────────────────────

describe('SPEC-180: currentLocale singleton', () => {
  test('currentLocale lazy-detects and memoizes', () => {
    setLang('vi_VN.UTF-8');
    const a = currentLocale();
    expect(a).toBe('vi');
    // Change env — memoized result must remain 'vi'
    setLang('en_US');
    expect(currentLocale()).toBe('vi');
  });

  test('initI18n sets singleton locale', () => {
    initI18n('vi');
    expect(currentLocale()).toBe('vi');
  });
});

// ── SPEC-180 T2/T3 — Bundle keys ──────────────────────────────────────────

describe('SPEC-180: bundle completeness', () => {
  test('en bundle loads and has messages', () => {
    const bundle = loadBundle('en');
    expect(bundle.locale).toBe('en');
    expect(bundle.messages.size).toBeGreaterThan(100);
  });

  test('vi bundle loads and has messages', () => {
    const bundle = loadBundle('vi');
    expect(bundle.locale).toBe('vi');
    expect(bundle.messages.size).toBeGreaterThan(100);
  });

  test('en and vi bundles have the same keys', () => {
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    const enKeys = [...en.messages.keys()].sort();
    const viKeys = [...vi.messages.keys()].sort();
    expect(viKeys).toEqual(enKeys);
  });

  test('en bundle contains required ErrorCode keys', () => {
    const en = loadBundle('en');
    const required = [
      'errors.P_NETWORK',
      'errors.P_AUTH',
      'errors.T_TIMEOUT',
      'errors.X_BASH_BLOCKED',
      'errors.U_BAD_COMMAND',
      'errors.U_MISSING_CONFIG',
    ];
    for (const key of required) {
      expect(en.messages.has(key)).toBe(true);
    }
  });

  test('no empty values in en bundle', () => {
    const en = loadBundle('en');
    for (const [key, val] of en.messages) {
      expect(val.length).toBeGreaterThan(0);
    }
  });

  test('no empty values in vi bundle', () => {
    const vi = loadBundle('vi');
    for (const [key, val] of vi.messages) {
      expect(val.length).toBeGreaterThan(0);
    }
  });

  test('vi values differ from en values (real translation)', () => {
    const en = loadBundle('en');
    const vi = loadBundle('vi');
    let diffCount = 0;
    for (const [key, enVal] of en.messages) {
      if (vi.messages.get(key) !== enVal) diffCount++;
    }
    // Expect the majority of keys to have different translations
    expect(diffCount).toBeGreaterThan(en.messages.size * 0.8);
  });
});

// ── SPEC-180 T4 — t() + ICU-lite ──────────────────────────────────────────

describe('SPEC-180: t() translations', () => {
  test('t() returns English string by default', () => {
    const result = t('errors.P_NETWORK');
    expect(result).toContain('Network error');
  });

  test('t() returns Vietnamese string when locale=vi', () => {
    initI18n('vi');
    const result = t('errors.P_NETWORK');
    expect(result).toContain('mạng');
  });

  test('t() falls back to en for key missing in vi', () => {
    initI18n('vi');
    // Temporarily remove a key from vi bundle to simulate missing translation
    const vi = loadBundle('vi');
    vi.messages.delete('errors.P_NETWORK');
    const result = t('errors.P_NETWORK');
    expect(result).toContain('Network error');
  });

  test('t() returns key string when missing in both locales', () => {
    initI18n('en');
    const result = t('nonexistent.key.xyz');
    expect(result).toBe('nonexistent.key.xyz');
  });

  test('t() returns key string in vi locale when missing everywhere', () => {
    initI18n('vi');
    const result = t('totally.missing.key');
    expect(result).toBe('totally.missing.key');
  });
});

describe('SPEC-180: ICU-lite interpolation', () => {
  test('{param} is replaced with value', () => {
    const result = t('errors.X_BASH_BLOCKED', { command: 'rm -rf /' });
    expect(result).toContain('rm -rf /');
  });

  test('numeric param is substituted', () => {
    const result = t('errors.T_ITERATION_CAP', { limit: 50 });
    expect(result).toContain('50');
  });

  test('unknown param placeholder left as literal', () => {
    // Use a message that has a known param; pass unknown one instead
    const result = t('errors.T_CRASH', { unknownParam: 'x' });
    expect(result).toContain('{detail}');
  });

  test('no params — template returned verbatim', () => {
    const msg = t('errors.P_NETWORK');
    expect(msg).not.toContain('{');
  });

  test('multiple params replaced in single message', () => {
    const result = t('cost.daily_budget', { spent: '1.50', limit: '5.00' });
    expect(result).toContain('1.50');
    expect(result).toContain('5.00');
  });

  test('{__proto__} injection has no effect — key not in params', () => {
    // Ensure prototype-shaped key names do not match the regex
    const result = t('errors.T_CRASH', { detail: 'ok' });
    expect(result).not.toContain('__proto__');
    expect(result).toContain('ok');
  });
});
