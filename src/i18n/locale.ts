// locale.ts — SPEC-180: locale detection + singleton.

export type Locale = 'en' | 'vi';

const SUPPORTED: ReadonlySet<Locale> = new Set(['en', 'vi']);

/**
 * Normalize a raw locale string (e.g. "vi_VN.UTF-8", "en_US", "en") to a
 * supported Locale code, or undefined if not recognized.
 */
export function normalizeLocale(raw: string): Locale | undefined {
  const tag = raw.split(/[_.\s]/)[0]?.toLowerCase();
  if (!tag) return undefined;
  return SUPPORTED.has(tag as Locale) ? (tag as Locale) : undefined;
}

/**
 * Detect the active locale.
 *
 * Priority (highest → lowest):
 *   1. workspaceLocale param (workspace.json `locale` field)
 *   2. LANG env var
 *   3. LANGUAGE env var (colon-separated, first element used)
 *   4. Default: 'en'
 */
export function detectLocale(workspaceLocale?: string): Locale {
  if (workspaceLocale) {
    const normalized = normalizeLocale(workspaceLocale);
    if (normalized) return normalized;
  }

  const lang = process.env['LANG'];
  if (lang) {
    const normalized = normalizeLocale(lang);
    if (normalized) return normalized;
  }

  const language = process.env['LANGUAGE'];
  if (language) {
    const first = language.split(':')[0] ?? '';
    const normalized = normalizeLocale(first);
    if (normalized) return normalized;
  }

  return 'en';
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _cached: Locale | null = null;

/** Initialize the cached locale. Call once at startup (e.g. from initI18n). */
export function setCurrentLocale(locale: Locale): void {
  _cached = locale;
}

/** Return the currently cached locale, detecting lazily if not yet set. */
export function currentLocale(): Locale {
  if (_cached === null) _cached = detectLocale();
  return _cached;
}

/** Reset the cached locale (used in tests). */
export function __resetLocaleCache(): void {
  _cached = null;
}
