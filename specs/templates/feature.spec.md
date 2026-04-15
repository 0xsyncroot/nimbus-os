---
id: SPEC-XXX
title: <10 words max, actionable>
status: draft          # draft | approved | in-progress | implemented | deprecated
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1          # v0.1 | v0.2 | v0.3 | v0.4 | v0.5
layer: core            # core | ir | providers | platform | tools | permissions | safety | observability | cost | channels | storage | spec | onboard | browser | dreaming | meta
depends_on: []         # [SPEC-XXX, META-YYY]
blocks: []             # specs that cannot start until this is done
estimated_loc: 250
files_touched:
  - src/module/file.ts
  - tests/module/file.test.ts
---

# <Title>

## 1. Outcomes

*What measurable user gains does this feature deliver? 2-4 bullets.*

- User can X within Y
- System produces Z with property W
- Cache hit ≥N% for case A

## 2. Scope

### 2.1 In-scope
- Bullets of what THIS spec covers

### 2.2 Out-of-scope (defer to other specs)
- Thing X → see SPEC-YYY
- Thing Z → deferred to v0.2

## 3. Constraints

### Technical
- Bun ≥1.2, no Node-specific shims
- TypeScript strict mode
- Max 400 LoC per file
- No `any` types

### Performance
- Operation X <Nms cold, <Mms warm
- Memory overhead <KKB

### Resource / Business
- 1 dev part-time
- Offline-first (no cloud SaaS dependency)

## 4. Prior Decisions

*Decision → why NOT alternative. Critical for future maintainers.*

- **JSONL over SQLite** — append-only crash-safe, grep friendly
- **Singleton per workspace** — prevent cross-workspace leak; simpler lifecycle
- **No class inheritance** — functional + closures per project convention

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Define Zod schema | `validate()` rejects malformed, accepts valid fixtures | 30 | — |
| T2 | Implement loader | `load()` returns typed result, throws `NimbusError(code)` on corruption | 80 | T1 |
| T3 | Hook into CLI | `nimbus <cmd>` works e2e, exit code 0 on success | 60 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `path/to/file.test.ts`: cover create, load, update, corrupted-recovery
- Fixture tests for Zod edge cases
- Error throw test for each `NimbusError` case

### 6.2 E2E Tests
- `tests/e2e/feature.test.ts`: command exits 0, dir structure asserted

### 6.3 Performance Budgets
- `load()` <50ms warm via `bun:test` bench
- Memory: <5MB heap growth per invocation

### 6.4 Security Checks
- Path traversal rejected (`../etc`)
- File mode 0600 on write
- No secrets logged in audit

## 7. Interfaces

```ts
// Zod schema (source of truth for validation)
const XxxInputSchema = z.object({
  field: z.string().min(1).max(64),
})
export type XxxInput = z.infer<typeof XxxInputSchema>

// Function signatures
export interface XxxStore {
  create(input: XxxInput): Promise<Xxx>
  load(id: string): Promise<{ meta: Xxx; paths: Paths }>
  list(): Promise<Xxx[]>
}

// Events emitted
type XxxEvent =
  | { type: 'xxx.created'; id: string }
  | { type: 'xxx.updated'; id: string; diff: string }
```

## 8. Files Touched

- `src/module/file.ts` (new, ~80 LoC)
- `src/module/fileStore.ts` (new, ~100 LoC)
- `tests/module/file.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Should X be configurable? (defer decision to v0.2)
- [ ] Concurrent access semantics (ASK user)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: approved after self-review (4 min)
