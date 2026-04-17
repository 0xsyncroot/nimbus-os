---
id: SPEC-911
title: SDD spec dev tooling — internal parser/validator/indexer
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: spec
depends_on: [META-010]
blocks: []
estimated_loc: 340
files_touched:
  - scripts/spec/parser.ts
  - scripts/spec/validator.ts
  - scripts/spec/indexer.ts
  - scripts/spec/links.ts
  - scripts/spec/cli.ts
  - tests/spec/*.test.ts
---

# SDD Spec Dev Tooling (internal)

## 1. Outcomes

- `bun run spec validate <path>` checks 6 mandatory elements + frontmatter + link resolution in <200ms per spec
- `bun run spec index` regenerates `/specs/_index.md` from live `.spec.md` files in <500ms for 50 specs
- `bun run spec list [--status=X]` prints tabular spec list; `bun run spec show <ID>` prints single spec
- `bun run spec new <layer> <name>` scaffolds from `templates/feature.spec.md` with correct ID + path

## 2. Scope

### 2.1 In-scope
- Frontmatter parser via `gray-matter` (YAML)
- Validator: 10 concrete rules (see §6.1)
- Link resolver: `[SPEC-XXX]`, `[META-YYY]` references resolve to existing files
- Indexer: groups by layer/module, writes `_index.md` with deps + status tables
- Commands: `init | new | list | show | validate | index`
- Exit codes: 0 ok, 1 validation error, 2 not found, 3 internal error

### 2.2 Out-of-scope
- `check-drift` (spec↔code sync) → v0.2
- `graph` (DAG visualization) → v0.2
- Git hook integration (pre-commit) → provided as docs, not implemented here

## 3. Constraints

### Technical
- gray-matter, Zod, no other deps
- Atomic write for `_index.md` (temp + rename)
- Absolute paths throughout; no `cwd` dependence
- Crucially: SPEC-911 bootstraps SDD — implemented FIRST so other specs are validated against it

### Performance
- Validate single spec <200ms (read + parse + check)
- Index 50 specs <500ms

## 4. Prior Decisions

- **gray-matter over custom parser** — battle-tested, small, already in stack
- **Validator as standalone lib** — reused by future `check-drift`, editor plugins
- **Indexer writes_index.md; no SQLite** — simple, diffable in git
- **10 rules hardcoded v0.1** — extensible via plugin v0.2; MVP ships fixed set
- **No `--fix`** — specs are human artifacts; fix manually to keep author intent clear

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | `parser.ts` — gray-matter wrapper + Zod | Frontmatter schema enforced; body split | 50 | — |
| T2 | `validator.ts` — 10 rules | Each rule has its own fn + test; produces typed `ValidationError[]` | 100 | T1 |
| T3 | `links.ts` — cross-ref resolver | `[SPEC-101]` → file path or `ERR_UNKNOWN_SPEC` | 40 | T1 |
| T4 | `indexer.ts` — regenerate `_index.md` | Grouped by module, sorted by ID | 60 | T1 |
| T5 | `cli.ts` — commands + arg parsing | Each subcommand has unit test | 80 | T2, T3, T4 |
| T6 | `init` + `new` commands | `new permissions foo` creates SPEC-40X-foo.spec.md | 30 | T5 |

## 6. Verification

### 6.1 Unit Tests — Validator 10 Rules (all must pass)

| # | Rule | Failure Error |
|---|------|---------------|
| 1 | Frontmatter present, parses as YAML | `SPEC_VALIDATION: frontmatter missing` |
| 2 | `id` matches `(SPEC\|META\|MOD)-\d{3}` | `SPEC_VALIDATION: id format` |
| 3 | `title` present, ≤80 chars | `SPEC_VALIDATION: title length` |
| 4 | `status` ∈ {draft, approved, in-progress, implemented, deprecated} | `SPEC_VALIDATION: status value` |
| 5 | `release` ∈ {v0.1 … v0.5} — REQUIRED for `SPEC-*`, OPTIONAL for `META-*`/`MOD-*` | `SPEC_VALIDATION: release value` / `SPEC_VALIDATION: release required for SPEC-*` |
| 6 | All 6 mandatory body sections present: Outcomes, Scope, Constraints, Prior Decisions, Task Breakdown, Verification. **Drafts** (status=`draft`) only require Outcomes — remaining sections are enforced at `approved`/`in-progress`/`implemented`. | `SPEC_VALIDATION: missing section <name>` |
| 7 | `depends_on` refs all resolve to existing files AND the transitive-closure does NOT contain `id` (no self-cycle) | `SPEC_VALIDATION: unresolved dep SPEC-999` / `SPEC_VALIDATION: dependency cycle via <path>` |
| 8 | `files_touched` paths start with `src/`, `tests/`, or `bench/`; `.md` allowed under `src/onboard/templates/` | `SPEC_VALIDATION: bad path` |
| 9 | Body word count (excluding code blocks): >800 emits **warn** (exit 0), >1500 emits **hard fail** (exit 1). Thresholds configurable via `~/.nimbus/spec.config.json` | `SPEC_VALIDATION: body length warn/fail` |
| 10 | Changelog section has ≥1 entry dated YYYY-MM-DD (drafts exempt — no history yet) | `SPEC_VALIDATION: changelog missing entry` |

**Error-channel duality**: validator returns typed `ValidationError[]` for display (string format `SPEC_VALIDATION: ...`) AND programmatic callers throw `NimbusError(ErrorCode.S_CONFIG_INVALID, {rule, path, ...})` per META-003. Keep display string stable; use NimbusError for non-interactive callers (editor plugins, CI).

- `parser.test.ts`:
  - Valid IDs: `SPEC-101`, `META-001`, `MOD-010` (always 3 digits)
  - Invalid IDs: `XYZ-001`, `SPEC-1`, `SPEC-1234`, `spec-001` (case-sensitive), `MOD-10` (must be 3 digits)
  - Fixture: META spec without `release` → rule 5 passes; SPEC spec without `release` → rule 5 fails
  - Valid + invalid fixtures round-trip through gray-matter
- `indexer.test.ts`: produces deterministic output; identical input → identical bytes; groups META/SPEC/MOD into distinct sections
- `links.test.ts`: resolver rejects unknown IDs; handles all three prefixes (`SPEC-`, `META-`, `MOD-`)

### 6.2 E2E Tests
- `tests/e2e/spec-validate.test.ts`: run `bun run spec validate specs/` over bundled fixtures → exit 0
- `tests/e2e/spec-index.test.ts`: add new fixture spec → `bun run spec index` updates `_index.md` correctly
- `tests/e2e/spec-new.test.ts`: `bun run spec new permissions my-feature` creates file with right ID range

### 6.3 Performance Budgets
- Single validate <200ms; full 50-spec index <500ms

### 6.4 Security Checks
- Reject spec files with `<script>`, raw HTML inject in frontmatter (sanitized during index render)
- Path guard: `--path` arg cannot escape repo root

## 7. Interfaces

```ts
export const SpecFrontmatterSchema = z.object({
  id: z.string().regex(/^(SPEC|META|MOD)-\d{3}$/),
  title: z.string().min(3).max(80),
  status: z.enum(['draft','approved','in-progress','implemented','deprecated']),
  version: z.string(),
  owner: z.string(),
  created: z.string(),
  updated: z.string(),
  release: z.enum(['v0.1','v0.2','v0.3','v0.4','v0.5']).optional(),  // required for SPEC-*, optional for META-*/MOD-*
  layer: z.string(),
  depends_on: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  estimated_loc: z.number().int().nonnegative(),
  files_touched: z.array(z.string()),
}).refine(
  d => d.id.startsWith('SPEC-') ? !!d.release : true,
  { message: 'release required for SPEC-* (not META/MOD)', path: ['release'] },
)
export type SpecFrontmatter = z.infer<typeof SpecFrontmatterSchema>

export interface ParsedSpec {
  path: string
  frontmatter: SpecFrontmatter
  body: string
  sections: Map<string, string>   // section name → content
}

export interface ValidationError {
  rule: number        // 1-10
  code: string        // e.g. 'SPEC_VALIDATION: missing section Outcomes'
  path: string
  line?: number
}

export interface SpecTools {
  parse(path: string): Promise<ParsedSpec>
  validate(spec: ParsedSpec, all?: ParsedSpec[]): ValidationError[]
  resolveLinks(spec: ParsedSpec, all: ParsedSpec[]): Map<string, string>
  buildIndex(all: ParsedSpec[]): string   // markdown content for _index.md
}

// CLI
// bun run spec init                 — bootstrap templates/ if missing
// bun run spec new <layer> <name>   — scaffold new spec
// bun run spec list [--status=X]    — table of specs
// bun run spec show <SPEC-XXX>      — print full spec
// bun run spec validate [<path>]    — validate single/all
// bun run spec index                — regenerate _index.md
```

## 8. Files Touched

- `scripts/spec/parser.ts` (~60 LoC)
- `scripts/spec/validator.ts` (~120 LoC)
- `scripts/spec/links.ts` (~40 LoC)
- `scripts/spec/indexer.ts` (~70 LoC)
- `scripts/spec/cli.ts` (~80 LoC)
- `tests/spec/` (~300 LoC)

## 9. Open Questions

- [ ] Should `validate` enforce `updated` date matches git mtime (v0.2?)
- [ ] Allow `.spec.yaml` in addition to `.spec.md` — leaning no (consistency)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — id regex supports `SPEC|META|MOD` prefixes; `release` field optional at schema level with refine() requiring it only for `SPEC-*`
- 2026-04-15 @hiepht: revise per reviewer (round 2) — rule 9 split into warn/fail thresholds; rule 8 allows `bench/` + `.md` under `src/onboard/templates/`; rule 7 adds transitive cycle detection; document NimbusError dual-channel
- 2026-04-17 @hiepht: v0.3.18 CI unblock — rule 6 and rule 10 are now lenient for `status: draft` (drafts only require Outcomes; changelog exempt). Matches SDD semantics where drafts are seed sketches before approval. Non-draft statuses still enforce all 6 sections + dated changelog.
