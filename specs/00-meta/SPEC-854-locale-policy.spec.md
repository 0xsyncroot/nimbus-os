---
id: SPEC-854
title: locale-policy — all user strings through t(key, locale)
status: approved
version: 0.2.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: meta
depends_on: [META-011, SPEC-180]
blocks: []
estimated_loc: 100
files_touched:
  - src/i18n/locale.ts
  - src/i18n/format.ts
  - src/i18n/en.json
  - src/i18n/vi.json
  - src/channels/cli/slashCommands.ts
  - src/cli.ts
  - src/cli/commands/check.ts
  - src/cli/debug/doctor.ts
  - src/observability/errorFormat.ts
  - tests/i18n/locale.test.ts
---

# locale-policy — All User Strings Through t(key, locale)

## 1. Outcomes

- Every user-facing string in `src/channels/cli/`, `src/cli/`, and `src/onboard/` is routed through `t(key, locale)`.
- No direct EN/VI literal mixing in source code (gap audit 1.2 + 1.23 violations eliminated).
- Locale detected from `env.LANG` (e.g. `vi_VN.UTF-8` → `vi`), with `en` fallback.
- `/locale <en|vi>` slash command overrides locale for the current session.
- `--help` output and `nimbus check` output use the resolved locale consistently.

## 2. Scope

### 2.1 In-scope
- Formalize and document `src/i18n/locale.ts` interface (may already exist from SPEC-180; amend or create as needed).
- `t(key: string, locale: Locale, vars?: Record<string, string>): string` — core translation function.
- `detectLocale(): Locale` — reads `process.env.LANG`, normalizes to `'en' | 'vi'`.
- Session-scoped locale override via `/locale` slash command (stored in session preferences).
- Audit `src/channels/cli/`, `src/cli/`, `src/onboard/` for bare string literals that should be in message bundles.
- Add missing keys to `en.ts` and `vi.ts` for flagged violations from gap audit 1.2/1.23.
- Lint rule or CI grep: `src/channels/cli/**/*.ts` must not contain bare Vietnamese string literals (`grep -P "[\x{0300}-\x{036f}]|\bkhông\b|\banh\b"` or similar).

### 2.2 Out-of-scope (defer to other specs)
- RTL languages, plural forms, date formatting — defer to v0.5.
- SOUL.md / MEMORY.md content (user-curated; agent writes in agent's own locale, not controlled here).
- Log messages (pino internal) — logs are always EN for grep-friendliness; this policy covers user-facing output only.

## 3. Constraints

### Technical
- Bun ≥1.2; TypeScript strict, no `any`.
- `t()` must be synchronous — no async locale loading at call sites.
- Message bundles loaded once at startup (`requireLocale(locale)`) and cached.
- Fallback chain: `vi[key] ?? en[key] ?? key` (never silently drops to empty string).
- Max 400 LoC per file.

### Performance
- `t()` lookup: O(1) property access on pre-loaded bundle object.
- Bundle sizes: `en.ts` ≤300 keys, `vi.ts` ≤300 keys (v0.4 scope).

### Resource / Business
- 1 dev, ~0.5 days audit + wire-up.

## 4. Prior Decisions

- **`t(key, locale)` not `i18next` / `react-intl`** — SPEC-180 already established a lightweight bundle approach for nimbus-os. Full i18n libraries add 200–500KB to binary. Nimbus targets 2 locales; a lookup table is sufficient.
- **`env.LANG` as source of truth** — standard POSIX locale env var; covers Linux, macOS, WSL. `LANGUAGE` and `LC_ALL` are secondary signals; consult in that order.
- **`/locale` slash command** — user-discovered locale switch is more discoverable than a config file edit. Stored in session preferences (SPEC-122) so it persists within a session but resets on restart (explicit preference).
- **Lint rule for bare VN literals** — enforced in CI to prevent regression. Safer than relying on code review.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Formalize `src/i18n/locale.ts` | Exports `t()`, `detectLocale()`, `setLocale()`, `Locale` type | 40 | SPEC-180 |
| T2 | `/locale` slash command | `/locale en` and `/locale vi` switch session locale; confirmation rendered in new locale | 20 | T1, SPEC-842 |
| T3 | Audit + migrate bare literals | All flagged gap-audit violations moved to message bundles; CI grep passes | 30 | T1 |
| T4 | Unit tests | `detectLocale()` from LANG variants; `t()` fallback chain; `/locale` switch reflected in next render | 30 | T1, T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/i18n/locale.test.ts`:
  - `LANG=vi_VN.UTF-8` → `detectLocale()` = `'vi'`.
  - `LANG=en_US.UTF-8` → `'en'`.
  - `LANG=fr_FR.UTF-8` → fallback `'en'`.
  - `t('error.U_UI_BUSY.title', 'en')` returns English string.
  - `t('missing.key', 'vi')` → falls back to `en` → falls back to key string.
  - Session override: `setLocale('vi')` → subsequent `t()` calls use VI bundle.

### 6.2 CI Lint Gate
- `grep -rn --include="*.ts" --include="*.tsx" "[àáạảã]" src/channels/cli/ src/cli/ src/onboard/` = 0 (no bare Vietnamese diacritics in source).
- `grep -rn --include="*.ts" "\"Xin chào\|Không tìm thấy\|Cảm ơn" src/` = 0.

### 6.3 E2E
- `LANG=vi_VN.UTF-8 nimbus --help` output in Vietnamese.
- `/locale en` during session → next prompt message in English.

## 7. Interfaces

```ts
// src/i18n/locale.ts

export type Locale = 'en' | 'vi'

/**
 * Detect locale from process.env.LANG.
 * Falls back to 'en' for unknown/unset LANG.
 */
export function detectLocale(): Locale

/**
 * Override locale for current session (in-memory only).
 */
export function setLocale(locale: Locale): void

/**
 * Translate key to current locale. Fallback chain: vi → en → key.
 * vars: optional interpolation map {{ key }} → value.
 */
export function t(key: string, vars?: Record<string, string>): string

/**
 * Same as t() but uses explicit locale (for tests + pre-session use).
 */
export function tLocale(key: string, locale: Locale, vars?: Record<string, string>): string
```

## 8. Files Touched

- `src/i18n/locale.ts` (amend or new, ~40 LoC)
- `src/i18n/messages/en.ts` (amend, ~+30 keys)
- `src/i18n/messages/vi.ts` (amend, ~+30 keys)
- `src/channels/cli/slashCommands.ts` (amend: add `/locale` command + migrate bare literals)
- `tests/i18n/locale.test.ts` (amend or new, ~30 LoC)

## 9. Open Questions

- [ ] Should `setLocale()` persist across sessions (workspace config) or remain session-scoped? (current: session-scoped; persist to workspace config if user requests in v0.4.1)
- [ ] Vietnamese tone marks in CI grep pattern — is the current regex sufficient for all VN diacritics? (verify with reviewer before merging)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — gap audit 1.2/1.23 flagged EN/VI mixing in help + check output; no spec governed i18n routing)
- 2026-04-17 developer-locale: implemented — setLocale()/tLocale() added to locale.ts/format.ts; 36 new keys in en.json/vi.json; check.ts/doctor.ts/cli.ts/errorFormat.ts routed through t(); /locale slash command added; 31-test suite green
