---
id: SPEC-302
title: Builtin FS tools (Read/Write/Edit/Grep/Glob)
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: tools
depends_on: [SPEC-301, SPEC-401]
blocks: [SPEC-103]
estimated_loc: 400
files_touched:
  - src/tools/builtin/Read.ts
  - src/tools/builtin/Write.ts
  - src/tools/builtin/Edit.ts
  - src/tools/builtin/Grep.ts
  - src/tools/builtin/Glob.ts
  - src/tools/builtin/fsHelpers.ts
  - tests/tools/builtin/*.test.ts
---

# Builtin Filesystem Tools

## 1. Outcomes

- Agent can Read/Write/Edit files, Grep content, and Glob paths inside the workspace safely
- Path traversal (`../../etc/passwd`), symlink attacks (TOCTOU), and sensitive file access (`.ssh/`, `.env`, `~/.nimbus/secrets.enc`) rejected with `X_PATH_BLOCKED` / `X_CRED_ACCESS`
- Read returns offset/limit windows of files up to 10MB; larger files rejected with actionable error
- Edit enforces unique-match semantics (exact-string, non-unique → error) to prevent accidental over-replacement

## 2. Scope

### 2.1 In-scope
- **Read**: returns file content with line numbers (`cat -n` format), supports `offset`/`limit`, binary detection
- **Write**: atomic write (tmp + rename), rejects if file exists (requires explicit flag — v0.2) — v0.1 allows overwrite with `dangerous:true` confirm
- **Edit**: exact-string replace; enforces `old_string` unique in file (or `replaceAll:true`); mtime+size compare at edit time (fileState tracking across tool calls is a v0.2 feature — v0.1 scope is per-call re-read)
- **Grep**: ripgrep-like via `Bun.spawn(['rg', ...])` with fallback to JS implementation; modes `files_with_matches|content|count`
- **Glob**: pattern match via `Bun.Glob` (native in Bun ≥1.1); returns mtime-sorted paths
- All inputs Zod-validated, all paths run through `pathValidator` (from SPEC-401 `permissions/` module — SPEC-404 merged) BEFORE any fs operation
- File size limits: Read 10MB, Write 50MB, Grep skip files >5MB

### 2.2 Out-of-scope (defer to other specs)
- NotebookRead/Edit (`.ipynb`) → v0.2
- PDF/image Read → v0.2
- File watching / incremental grep → v0.3
- `ripgrep` binary vendoring — v0.1 uses system `rg` if present, JS fallback otherwise

## 3. Constraints

### Technical
- Bun-native: `Bun.file`, `Bun.Glob`, `Bun.spawn`. No `fs.promises` shims.
- TypeScript strict, no `any`
- Every tool ≤400 LoC; `fsHelpers.ts` shared for path resolution + size check
- Max read 10MB hard cap (prevents OOM)

### Performance
- Read 100KB file <20ms warm
- Grep over 10k-file repo <2s warm (rg), <15s JS fallback
- Glob `**/*.ts` across 10k files <500ms

### Security (per META-009 T6, T13)
- ALL paths → `pathValidator.check(absPath)` — workspace root anchor, symlink resolve with `O_NOFOLLOW` where supported, case-fold for sensitive patterns
- Read/Write/Edit reject symlinks pointing outside workspace (TOCTOU: re-check inode after open)
- Grep output redacts lines matching secret patterns (`sk-ant-*`, `sk-*`, `ghp_*`) with `***redacted***`

## 4. Prior Decisions

- **Exact-string Edit only, no regex in v0.1** — regex introduces ambiguity, makes LLM diffs harder to verify. Matches Claude Code pattern.
- **Unique-match enforced by default** — if `old_string` appears 3 times and LLM calls without `replaceAll`, throw `T_VALIDATION` with message "found 3 occurrences; provide more context or set replaceAll:true". Prevents silent over-replacement bugs.
- **System `rg` preferred over JS** — 50× faster on large repos. JS fallback only when `rg` not in PATH. Detected once at registry init.
- **Read returns line numbers** — `cat -n` format. Helps Edit work (LLM can reference line numbers when drafting `old_string`).
- **Atomic write via tmp+rename** — crash-safe. On Windows, rename fails if target file is open; retry loop with graceful-fs fallback (surfaces as `NimbusError(T_CRASH)` after 3 tries).
- **File mode per target class via `chooseMode(path)`** — workspace root markdown (SOUL.md/IDENTITY.md/MEMORY.md/TOOLS.md) → 0600, anything else → 0644. Prevents accidental world-readable writes to identity/memory files. SOUL.md/IDENTITY.md are additionally blocked by pathValidator (agent may not write); chooseMode is defense-in-depth when the path is allowed.
- **`rg` binary resolved to absolute path at registry init** — `Bun.which('rg')` cached; rejected if resolved path lies under user-writable dirs (e.g., `$HOME`, `/tmp`). Hardening against PATH hijack (T5 supply-chain). JS fallback engaged when `rg` resolution fails.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `fsHelpers.ts`: `resolveWorkspacePath(ws, p)`, `assertSize`, `readTextWithLineNumbers`, `isBinary`, `chooseMode(path)` | all call `pathValidator.check`; binary detect via first 8KB null-byte scan; `chooseMode` returns 0600 for workspace markdown roots | 80 | SPEC-401 |
| T2 | `Read` tool | offset/limit windowing; 10MB cap; binary → `T_VALIDATION`; not-found → `T_NOT_FOUND` | 60 | T1 |
| T3 | `Write` tool | atomic tmp+rename; parent dir must exist; file mode 0644 | 60 | T1 |
| T4 | `Edit` tool | unique-match enforced; `replaceAll` opt-in; returns diff summary | 80 | T1 |
| T5 | `Grep` tool | rg detection + spawn + parse; JS fallback; secret redaction | 80 | T1 |
| T6 | `Glob` tool | `Bun.Glob` with mtime sort; max 10k results | 40 | T1 |

## 6. Verification

### 6.1 Unit Tests
- `tests/tools/builtin/Read.test.ts`:
  - Valid file → content with line numbers
  - `offset:100, limit:50` → lines 100-149
  - >10MB file → `NimbusError(T_VALIDATION, {size})`
  - Symlink to `/etc/passwd` → `X_PATH_BLOCKED`
  - `.env` inside workspace → `X_CRED_ACCESS`
  - Binary file (PNG) → `T_VALIDATION` with helpful message
  - Non-existent path → `T_NOT_FOUND`
- `tests/tools/builtin/Write.test.ts`:
  - Write + re-read round-trip equal
  - Parent missing → `T_NOT_FOUND`
  - Crash during write leaves no partial file (verify via `.tmp` absent)
  - Path outside workspace → `X_PATH_BLOCKED`
- `tests/tools/builtin/Edit.test.ts`:
  - `old_string` appears 1× → replaced, returns 1-line diff
  - `old_string` appears 3× without `replaceAll` → `T_VALIDATION` with count
  - `old_string` appears 3× with `replaceAll:true` → all replaced
  - `old_string` not found → `T_VALIDATION`
- `tests/tools/builtin/Grep.test.ts`:
  - Match in fixture files → correct line:col
  - Line containing `sk-ant-api03-ABCDEF...` → output line shows `***redacted***`
  - `rg` not in PATH → JS fallback engaged (mocked)
- `tests/tools/builtin/Glob.test.ts`:
  - `**/*.ts` returns .ts files sorted by mtime desc
  - Result capped at 10k

### 6.3 Performance Budgets
- Read 100KB <20ms warm (bench)
- Grep 10k-file repo <2s warm (skipped if rg absent)

### 6.4 Security Checks
- Path traversal attempt `../../etc/passwd` from inside workspace → `X_PATH_BLOCKED`
- Symlink TOCTOU: create symlink after validator check but before open → detected via post-open `fstat` compare (best-effort; documented limitation)
- Grep never returns secrets verbatim (redaction enforced in tests)
- Write file mode: 0644 default, 0600 for workspace markdown roots (asserted via `fs.stat`)
- `rg` binary path: if resolved under `$HOME`/`/tmp` → JS fallback engaged, `SecurityEvent` emitted with severity `warning`

## 7. Interfaces

```ts
// Zod schemas (concrete, strict)
export const ReadInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(10000).optional(),
}).strict()

export const WriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(50 * 1024 * 1024),
}).strict()

export const EditInputSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().default(false),
}).strict()

export const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  mode: z.enum(['files_with_matches', 'content', 'count']).default('files_with_matches'),
  caseInsensitive: z.boolean().default(false),
  headLimit: z.number().int().positive().max(10000).default(250),
}).strict()

export const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
}).strict()

// Tool registrations (factory pattern takes pathValidator)
export function createReadTool(deps: { pathValidator: PathValidator }): Tool<ReadInput, ReadOutput>
export function createWriteTool(deps: { pathValidator: PathValidator }): Tool<WriteInput, WriteOutput>
export function createEditTool(deps: { pathValidator: PathValidator }): Tool<EditInput, EditOutput>
export function createGrepTool(deps: { pathValidator: PathValidator; rgPath?: string }): Tool<GrepInput, GrepOutput>
export function createGlobTool(deps: { pathValidator: PathValidator }): Tool<GlobInput, GlobOutput>
```

## 8. Files Touched

- `src/tools/builtin/fsHelpers.ts` (new, ~80 LoC)
- `src/tools/builtin/Read.ts` (new, ~60 LoC)
- `src/tools/builtin/Write.ts` (new, ~60 LoC)
- `src/tools/builtin/Edit.ts` (new, ~80 LoC)
- `src/tools/builtin/Grep.ts` (new, ~80 LoC)
- `src/tools/builtin/Glob.ts` (new, ~40 LoC)
- `tests/tools/builtin/*.test.ts` (new, ~400 LoC)

## 9. Open Questions

- [ ] Bundle `ripgrep` as optional install? Bun binary `--compile` cannot embed native binaries easily — defer.
- [ ] Read BOM handling for UTF-8-BOM files — default strip or preserve? Lean strip.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — depends_on aligned to SPEC-401 (SPEC-404 merged); add `chooseMode(path)` helper for workspace markdown 0600; `rg` PATH hardening (reject user-writable dirs); clarify Edit fileState is v0.2
