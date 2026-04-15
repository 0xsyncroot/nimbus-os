---
id: SPEC-304
title: MemoryTool — append-only MEMORY.md writer
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: tools
depends_on: [SPEC-301, SPEC-104, SPEC-401, META-003]
blocks: [SPEC-103]
estimated_loc: 120
files_touched:
  - src/tools/builtin/Memory.ts
  - src/tools/builtin/memoryLock.ts
  - tests/tools/builtin/Memory.test.ts
---

# MemoryTool — Append-Only MEMORY.md Writer

## 1. Outcomes

- Agent can persist long-term notes to `{workspace}/MEMORY.md` across sessions with one tool call
- Append is atomic + crash-safe; concurrent writes from parallel sub-agents (v0.3) serialize via file lock
- Conflict (file modified externally) → `S_MEMORY_CONFLICT` → reconcile block appended with both versions, never data loss
- Tool is the ONLY write path to MEMORY.md for the agent; direct `Write({path:'MEMORY.md'})` rejected by pathValidator

## 2. Scope

### 2.1 In-scope
- `Memory` tool: Zod input (`entry`, `section?`, `tags?`), appends structured entry to `MEMORY.md`
- Section auto-discovery: `entry` gets appended under header matching `section` arg (creates `## {section}` if absent) or to default `## Notes`
- File lock via `memoryLock.ts` (`.memory.lock` sidecar file with PID+timestamp; stale lock >30s reclaimed)
- External-modification detection: compare mtime+size before append; mismatch → reconcile
- Reconcile: append both last-read tail + new entry under `## Conflict {iso-ts}` section — never overwrite

### 2.2 Out-of-scope (defer to other specs)
- MEMORY consolidation / summarization → v0.4 Dreaming
- Vector search over MEMORY → v0.5 RAG
- Multi-file memory (TASKS.md, FACTS.md) → v0.2
- User-edited MEMORY merge via CRDT → no, simple last-write-safe with reconcile block

## 3. Constraints

### Technical
- `src/tools/builtin/Memory.ts` imports `SPEC-301` Tool interface, `SPEC-104` WorkspaceMemory, `SPEC-401` pathValidator (SPEC-404 merged into SPEC-401), `zod`
- Bun-native: `Bun.file`, `Bun.write`, atomic tmp+rename
- TypeScript strict, no `any`
- Max 400 LoC per file — split Memory.ts (tool) / memoryLock.ts (lock primitive)

### Performance
- Append <30ms warm (read-mtime + acquire-lock + write + release)
- Lock contention p99 <200ms under 5 concurrent sub-agents

### Security
- `path` is NEVER user-supplied — always derived as `{workspace.root}/MEMORY.md` via WorkspaceMemory
- Direct Write/Edit to `MEMORY.md` must be blocked in pathValidator (delegated — MemoryTool is sole writer) — documented dependency on SPEC-401
- Entry content capped at 4KB per call (prevents DoS via massive appends)

### Environment
- **Local filesystem only** — sidecar file lock is NOT safe on NFS/SMB (no atomic rename, no mtime precision). `acquireMemoryLock` checks filesystem type on first use; if remote FS detected, logs `S_MEMORY_CONFLICT{reason:'remote_fs'}` and falls through to best-effort single-process mode. Supported via `statfs`/`GetVolumeInformation`. Documented in §9 Open Questions for v0.2 hardening.

## 4. Prior Decisions

- **Append-only, never overwrite** — agent cannot delete memory. Reduces risk of the LLM "forgetting things on purpose" after confusion. User edits via `$EDITOR` directly outside the tool.
- **File lock via sidecar, not `flock(2)`** — Windows lacks POSIX flock; sidecar file works cross-platform. Stale-lock reclaim at 30s.
- **Sidecar carries PID + random nonce** — Windows can reuse PIDs faster than Linux. Reclaim check is `pid-dead OR nonce-not-mine OR age>30s`. Reader compares its own nonce against disk nonce to detect silent replacement from a crashed-then-restarted sibling.
- **Reconcile block, not merge** — CRDT/3-way-merge is over-engineering for markdown notes. When conflict detected, append both versions under a dated `## Conflict` header. User resolves manually.
- **Keep MemoryTool separate from Edit/Write** — special semantics (append-only, lock, reconcile) warrant dedicated tool. Also easier for LLM to reason about ("use Memory to remember X").

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `memoryLock.ts`: `acquire(path, timeoutMs)` / `release()` via sidecar `.memory.lock` | stale-lock (PID dead or age>30s) reclaimed; timeout → `S_MEMORY_CONFLICT` | 50 | — |
| T2 | `Memory.ts` tool: zod schema + append logic + reconcile on mtime-mismatch | unit tests pass; 4KB cap enforced; missing section auto-created | 60 | T1, SPEC-104 |
| T3 | Audit hook: emit turn event `memory.append` with entry digest | SHA-256 digest in event; raw entry NEVER logged at info | 10 | T2 |

## 6. Verification

### 6.1 Unit Tests
- `tests/tools/builtin/memoryLock.test.ts`:
  - Two concurrent `acquire` calls — second waits then succeeds after release
  - Stale lock (sidecar mtime >30s ago) → reclaimed
  - Dead PID in sidecar → reclaimed
  - Nonce mismatch on release → error logged (lock was stolen); release is no-op (don't unlock someone else's lock)
  - Timeout acquiring → `NimbusError(S_MEMORY_CONFLICT)`
  - Remote FS detected (mocked `statfs` returning nfs/cifs type) → logger.warn + best-effort mode engaged
- `tests/tools/builtin/Memory.test.ts`:
  - First call creates `MEMORY.md` with `## Notes` + entry
  - Entry with `section:'Tasks'` creates `## Tasks` header
  - Second call to same section appends under same header
  - Entry >4KB → `NimbusError(T_VALIDATION)`
  - External modification between read and write → reconcile block `## Conflict 2026-04-15T...`  appended containing prior tail + new entry
  - 5 concurrent append calls → all 5 entries present, no corruption, lock contention <200ms p99
  - `path` argument rejected — tool signature has no `path` input

### 6.3 Performance Budgets
- Single append <30ms warm
- 5 concurrent appends p99 <200ms

### 6.4 Security Checks
- Attempt `Edit({path:'MEMORY.md'})` → `X_PATH_BLOCKED` (pathValidator enforces MemoryTool is sole writer)
- 4KB cap enforced via Zod
- Entry content scanned for secret patterns (`sk-ant-*`, `sk-*`, `ghp_*`); match → `X_CRED_ACCESS` with helpful message "don't persist secrets to MEMORY"

## 7. Interfaces

```ts
// memoryLock.ts
export interface MemoryLockHandle {
  release(): Promise<void>
  readonly acquiredAt: number
}
export function acquireMemoryLock(
  lockPath: string,
  timeoutMs: number,
): Promise<MemoryLockHandle>  // throws NimbusError(S_MEMORY_CONFLICT) on timeout

// Sidecar content: {"pid": 12345, "nonce": "01HXX...", "acquiredAt": 1718000000000}
// Reclaim when: pid dead OR mtime > 30s ago OR (nonce-mismatch-on-reread when caller owns lock)

// Memory.ts
export const MemoryInputSchema = z.object({
  entry: z.string().min(1).max(4096),
  section: z.string().min(1).max(64).regex(/^[A-Za-z0-9 _-]+$/).optional(),
  tags: z.array(z.string().max(32)).max(8).optional(),
}).strict()

export type MemoryInput = z.infer<typeof MemoryInputSchema>

export interface MemoryOutput {
  section: string
  appendedBytes: number
  reconciled: boolean
}

export function createMemoryTool(deps: {
  workspace: WorkspaceMemory    // from SPEC-104 — `workspace.memoryPath` is the absolute MEMORY.md path
  pathValidator: PathValidator  // from SPEC-401
}): Tool<MemoryInput, MemoryOutput>

// Append algorithm (illustrative)
// 1. const memPath = workspace.memoryPath
// 2. const stat0 = await Bun.file(memPath).stat()
// 3. const lock = await acquireMemoryLock(memPath + '.lock', 5000)
// 4. try:
//      const stat1 = await Bun.file(memPath).stat()
//      const conflict = stat1.mtimeMs !== stat0.mtimeMs || stat1.size !== stat0.size
//      const text = await Bun.file(memPath).text()
//      const out = conflict
//        ? appendReconcile(text, input, new Date())
//        : appendToSection(text, input)
//      await Bun.write(memPath + '.tmp', out)
//      await rename(memPath + '.tmp', memPath)  // atomic
//    finally: await lock.release()
// 5. return { section, appendedBytes, reconciled: conflict }
```

## 8. Files Touched

- `src/tools/builtin/Memory.ts` (new, ~70 LoC)
- `src/tools/builtin/memoryLock.ts` (new, ~50 LoC)
- `tests/tools/builtin/Memory.test.ts` (new, ~120 LoC)
- `tests/tools/builtin/memoryLock.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Max MEMORY.md total size — cap at 1MB? Truncate oldest entries when exceeded? Defer to v0.4 Dreaming consolidation.
- [ ] Should `tags` render in markdown (`[tag1, tag2]`) or only in structured frontmatter? Lean inline for LLM readability.
- [ ] NFS/SMB support — v0.2 investigate `proper-lockfile` or server-coordinated locks for multi-machine workspace sync.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — align to SPEC-401 (SPEC-404 merged); add random nonce to sidecar for Windows PID-reuse edge; document NFS/SMB unreliability with fallback; rename `WorkspaceContext` → `WorkspaceMemory` to match SPEC-104 export
