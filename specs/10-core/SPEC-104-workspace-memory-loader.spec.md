---
id: SPEC-104
title: WorkspaceMemory — SOUL/IDENTITY/MEMORY/TOOLS loader
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-005, SPEC-101]
blocks: [SPEC-105, SPEC-304]
estimated_loc: 150
files_touched:
  - src/core/workspaceMemory.ts
  - src/core/memoryTypes.ts
  - tests/core/workspaceMemory.test.ts
---

# WorkspaceMemory Loader

## 1. Outcomes

- `loadWorkspaceMemory(wsId)` returns `{soulMd, identityMd?, memoryMd, toolsMd}` with parsed frontmatter + body text in <30ms warm.
- Missing `SOUL.md` → throws `NimbusError(S_SOUL_PARSE, {path})` with actionable message pointing to SPEC-901 init wizard; missing `IDENTITY.md` is OK (optional per META-005).
- Malformed frontmatter → fallback default template + `logger.warn`; loader never crashes due to user-edited markdown.
- Order of returned blocks matches META-005 §2.5 injection sequence, ready for SPEC-105 prompt backbone to splice in.

## 2. Scope

### 2.1 In-scope
- Read 4 markdown files per workspace via `platform/paths.ts` + `Bun.file`.
- Parse frontmatter via `gray-matter`; validate `schemaVersion: 1` per file.
- UTF-8 BOM strip + CRLF→LF normalize (for Windows-edited files; see plan §15.3).
- Memoized cache keyed by `(wsId, mtime)` — reload-on-next-session pattern, not live-watcher.
- `invalidate(wsId)` for MemoryTool (SPEC-304) to force reload after append.

### 2.2 Out-of-scope
- Writing to SOUL/IDENTITY/MEMORY (agent cannot — see META-005 §2.3).
- MemoryTool append logic → SPEC-304.
- System prompt assembly → SPEC-105.
- Dreaming write → v0.5.

## 3. Constraints

### Technical
- Bun native `Bun.file().text()`.
- `gray-matter` for frontmatter (allow `js-yaml` engine only; no eval).
- No symlink follow (`Bun.file` returns file content; verify `lstat.isSymbolicLink` → `X_PATH_BLOCKED`).
- TS strict; throw `NimbusError` everywhere.

### Performance
- `loadWorkspaceMemory()` <30ms warm (cache hit <0.1ms).
- Cold (4 file reads + parse): <80ms for typical 4KB files.

### Resource
- Per-file body cap: 256KB (reject with S_SOUL_PARSE). Typical SOUL <4KB.
- Cache size: per-workspace only; evict on `invalidate()` or 10min idle.

## 4. Prior Decisions

- **`gray-matter` with js-yaml only** — why not custom parser: gray-matter is battle-tested; disabling eval engine removes injection vector (T2 in META-009).
- **Fallback template on parse fail** — why not abort: user-edited file should not break chat. Warn + default keeps session alive.
- **mtime-keyed cache** — why not timestamp-only: multiple writes within one second (MemoryTool burst) — mtime granularity is sufficient since MemoryTool calls `invalidate()` explicitly post-write.
- **BOM strip + CRLF normalize** — why: Notepad on Windows adds both; LLM sees inconsistent formatting otherwise (cache miss penalty).
- **Separate `toolsMd` return (not merged into SOUL)** — why: TOOLS.md is runtime manifest for tool gate; SOUL is personality; different update cadence + consumers.
- **`invalidate(wsId)` is synchronous purge** — why: MemoryTool calls it post-append-before-return; async `invalidate` would race with next `load()` from the same turn. Sync deletion of `Map` entry is O(1) and safe.
- **`logger.warn` on fallback-template use** — why: tests can assert observability side effect; users debugging "why is my agent ignoring SOUL?" see the warning in logs immediately (no silent fallback).

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `memoryTypes.ts`: schemas for each MD frontmatter | rejects missing `schemaVersion`; TS types inferred | 30 | — |
| T2 | `loadFile(path)` helper: read + BOM strip + CRLF norm | returns `{frontmatter, body, mtime}`; throws `X_PATH_BLOCKED` on symlink | 30 | T1 |
| T3 | `loadWorkspaceMemory(wsId)` main | loads all 4 files in parallel via `Promise.all`; assembles result | 50 | T2 |
| T4 | Cache + `invalidate(wsId)` | stores per-wsId; `invalidate` clears entry; test race | 20 | T3 |
| T5 | Error path: missing IDENTITY → use default; missing SOUL → throw | verified in tests below | 20 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/workspaceMemory.test.ts`:
  - `describe('SPEC-104: workspaceMemory')`:
    - Fixture workspace with all 4 files → returns all 4 with correct frontmatter.
    - Missing `IDENTITY.md` → `identityMd` is `undefined`, no throw.
    - Missing `SOUL.md` → throws `NimbusError(S_SOUL_PARSE, {path})`.
    - Malformed frontmatter in `SOUL.md` → `logger.warn` captured (spy asserts call with code `S_SOUL_PARSE` + path) + default template; `soulMd.fallback === true`.
    - BOM + CRLF in `MEMORY.md` → body stripped of BOM, normalized to LF.
    - Symlinked `SOUL.md` → throws `NimbusError(X_PATH_BLOCKED)`.
    - File >256KB → throws `S_SOUL_PARSE`.
    - `schemaVersion: 2` frontmatter → throws `S_SCHEMA_MISMATCH`.
    - Cache hit: second call <0.1ms; `invalidate` reloads.

### 6.2 E2E Tests
- `tests/e2e/memory-load.test.ts`: freshly `nimbus init`'d workspace → load returns all 4 scaffolded files.

### 6.3 Performance Budgets
- Cold load 4 files (4KB each): <80ms.
- Warm (cache hit): <0.1ms.

### 6.4 Security Checks
- Symlink rejection verified (T17 cross-workspace).
- File size cap enforced (prevents DoS via 10GB SOUL.md).
- gray-matter engine confined to js-yaml; `eval` engine disabled (test that YAML with `!!js/function` raises `S_SOUL_PARSE`).

## 7. Interfaces

```ts
// memoryTypes.ts
export const SoulFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(64),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),      // YYYY-MM-DD per META-005 §2.2
})

export const MemoryFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export const ToolsFrontmatterSchema = z.object({
  schemaVersion: z.literal(1),
})

export interface MarkdownFile {
  frontmatter: Record<string, unknown>
  body: string                             // normalized: no BOM, LF line endings
  mtime: number                            // epoch ms
  fallback?: boolean                       // true when default template used
}

export interface WorkspaceMemory {
  soulMd: MarkdownFile
  identityMd?: MarkdownFile                // optional per META-005
  memoryMd: MarkdownFile
  toolsMd: MarkdownFile
  wsId: string
  loadedAt: number                         // epoch ms
}

// workspaceMemory.ts
export async function loadWorkspaceMemory(wsId: string): Promise<WorkspaceMemory>
export function invalidate(wsId: string): void            // synchronous cache purge — safe to call before next load()
export function peekCache(wsId: string): WorkspaceMemory | null   // for tests

// Default fallback template (used on parse fail)
export const DEFAULT_SOUL_BODY: string    // exported const for test assertion
```

## 8. Files Touched

- `src/core/workspaceMemory.ts` (new, ~100 LoC)
- `src/core/memoryTypes.ts` (new, ~40 LoC)
- `tests/core/workspaceMemory.test.ts` (new, ~150 LoC)

## 9. Open Questions

- [ ] Watch mode via `fs.watch` for live reload during `/soul edit`? Defer to v0.2; v0.1 uses invalidate-on-command.
- [ ] Merge IDENTITY into SOUL when both present, or keep separate in prompt? Per META-005 §2.5: separate blocks, preserves cache breakpoint.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
