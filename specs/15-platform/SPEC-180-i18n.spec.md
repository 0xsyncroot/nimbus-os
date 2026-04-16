---
id: SPEC-180
title: i18n — locale detection + en/vi message bundles
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
implemented: 2026-04-16
release: v0.2
layer: platform
depends_on: [SPEC-151]
blocks: []
estimated_loc: 150
files_touched:
  - src/i18n/locale.ts
  - src/i18n/en.json
  - src/i18n/vi.json
  - src/i18n/format.ts
  - tests/i18n/format.test.ts
---

# i18n — Locale Detection + en/vi Message Bundles

## 1. Outcomes

- All nimbus UI strings (error messages, banners, prompts, cost warnings) appear in the user's detected locale
- Vietnamese users see native-language error messages without any manual config step
- Missing translation keys silently fall back to English so no UI string is ever blank
- `workspace.json` locale override lets users pin a language regardless of system env

## 2. Scope

### 2.1 In-scope

- Locale detection from `LANG` / `LANGUAGE` env vars (e.g. `vi_VN.UTF-8` → `vi`); fallback `en`
- Config override: `workspace.json` `locale` field takes precedence over env detection
- Two bundled locales: `en.json` and `vi.json`; flat key-value structure `{"errors.X_BASH_BLOCKED": "..."}`
- `t(key, params?)` function with ICU-lite interpolation `{name}` syntax
- Missing key in active locale → silent fallback to `en` value; missing in both → return key as-is
- ~120 keys covering: ErrorCode messages (META-003), permission prompts, cost warnings, init wizard text, REPL banners
- Wire `t()` into: existing logger error messages, REPL banner, permission confirm prompts, cost banner from SPEC-702

### 2.2 Out-of-scope

- LLM response language — i18n covers only nimbus own UI strings, not model output
- Runtime locale switching without restart → deferred v0.3
- Additional locales beyond `en`/`vi` → v0.3 via community contribution
- Plural forms beyond ICU-lite `{count}` substitution → v0.3
- Right-to-left layout → not applicable for `en`/`vi`

## 3. Constraints

### Technical

- Bun-native, TypeScript strict, max 400 LoC per file, no `any`
- JSON bundles loaded once at startup via `Bun.file()` + `JSON.parse`; no runtime `require()`
- `t()` must be synchronous (called in hot render paths)

### Performance

- `t()` lookup <0.1ms (Map-based after parse)
- Startup bundle load <5ms for 120-key JSON

### Resource / Business

- 1 dev part-time
- No external i18n library dependency — ICU-lite implemented in ~30 LoC

## 4. Prior Decisions

- **Flat key-value JSON over nested objects** — simpler grep, safer merge on missing keys, consistent with logger string format
- **ICU-lite `{name}` only** — full ICU adds 200KB; nimbus strings don't need plural/gender; full ICU deferred v0.3
- **`vi` as second locale** — primary author is Vietnamese; real translation test validates the pipeline better than a stub locale
- **Silent fallback to `en`** — broken translation should never crash UI; translator can fix without a release
- **Locale detected at startup, not per-call** — avoids per-message env read; locale changes require restart (acceptable for v0.2)

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Locale detector | `LANG=vi_VN.UTF-8` → `vi`; `LANG=en_US` → `en`; unknown → `en`; config override wins | 20 | — |
| T2 | `en.json` baseline (~120 keys) | All ErrorCode slugs present; no empty values | 30 | — |
| T3 | `vi.json` translation | All 120 keys present; values differ from `en` | 30 | T2 |
| T4 | `t()` function + ICU-lite interpolation | `t('key', {name:'x'})` replaces `{name}`; missing key returns English fallback | 25 | T1-T3 |
| T5 | Wire into logger/REPL/errors/cost | Existing banners call `t()`; no raw strings remain in wired surfaces | 25 | T4 |
| T6 | Unit tests | 120-key coverage; fallback chain; interpolation edge cases | 40 | T1-T5 |

## 6. Verification

### 6.1 Unit Tests

- `tests/i18n/format.test.ts`: `LANG=vi` → `vi` locale loaded; `LANG=fr` → `en` fallback; key missing in `vi` → `en` value returned; key missing in both → key string returned
- ICU-lite: `{name}` replaced; `{count}` replaced; unknown param left as literal; no XSS via param injection

### 6.2 E2E Tests

- `tests/e2e/i18n.test.ts`: run `nimbus` with `LANG=vi_VN.UTF-8` → banner contains Vietnamese text; trigger a blocked-bash error → message in Vietnamese

### 6.3 Performance Budgets

- `bench/i18n.bench.ts`: `t('errors.X_BASH_BLOCKED')` p99 <0.1ms

### 6.4 Security Checks

- Param values are string-escaped before insertion (no `{__proto__}` injection vector)
- Bundle files are bundled at compile time; no dynamic locale file loading from user path

## 7. Interfaces

```ts
export type Locale = 'en' | 'vi'

export interface I18nBundle {
  locale: Locale
  messages: Record<string, string>
}

export function detectLocale(workspaceLocale?: string): Locale

export function t(key: string, params?: Record<string, string | number>): string

export function loadBundle(locale: Locale): I18nBundle

// Wiring helper used in logger/REPL
export function initI18n(workspaceLocale?: string): void
```

## 8. Files Touched

- `src/i18n/locale.ts` (new, ~40 LoC)
- `src/i18n/format.ts` (new, ~35 LoC)
- `src/i18n/en.json` (new, ~120 keys)
- `src/i18n/vi.json` (new, ~120 keys)
- `tests/i18n/format.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Should `vi.json` be reviewed by a native speaker before shipping? (quality — yes, file GitHub issue)
- [ ] Expose locale in `nimbus status` output? (discoverability — v0.2)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — locale detection + en/vi bundles for v0.2 UI strings
