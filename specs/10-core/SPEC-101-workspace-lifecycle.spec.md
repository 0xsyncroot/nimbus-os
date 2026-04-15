---
id: SPEC-101
title: Workspace lifecycle — create/load/list/switch
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-005, SPEC-151]
blocks: [SPEC-102, SPEC-104, SPEC-901]
estimated_loc: 180
files_touched:
  - src/core/workspace.ts
  - src/storage/workspaceStore.ts
  - src/core/workspaceTypes.ts
  - tests/core/workspace.test.ts
  - tests/storage/workspaceStore.test.ts
---

# Workspace Lifecycle

## 1. Outcomes

- `create(name)` builds `~/.nimbus/workspaces/{wsId}/` with `workspace.json` + scaffolded `SOUL.md`/`MEMORY.md`/`TOOLS.md` atomically (crash-safe: no half-created workspace left on disk).
- `load(wsId)` returns typed `Workspace` meta + resolved paths in <50ms warm; throws `S_SCHEMA_MISMATCH` if `schemaVersion` diverges.
- `list()` enumerates all workspaces under `workspacesDir()` sorted by `lastUsed` desc, ignoring non-conforming directories.
- `switch(wsId)` marks active workspace in user config; subsequent REPL sessions use it without flag.

## 2. Scope

### 2.1 In-scope
- `Workspace` Zod schema + `workspace.json` read/write.
- `workspaceStore.ts`: CRUD at filesystem level (create/load/list/delete/update).
- `workspace.ts`: higher-level lifecycle orchestration (calls store + writes scaffolded markdown via template strings).
- Atomic create: write to `workspace.json.tmp` → rename → `fsync` parent dir. On any step fail → rollback (`rm -rf {wsId}`).
- `wsId` generation: `ulid()` (sortable, URL-safe).

### 2.2 Out-of-scope
- SOUL.md / MEMORY.md content loading → SPEC-104
- Session CRUD inside workspace → SPEC-102
- Rename workspace → v0.2 (see META-001 evolution)
- Onboard wizard (user-facing prompts) → SPEC-901
- Delete with cost reconciliation → v0.2

## 3. Constraints

### Technical
- Bun ≥1.2 with `Bun.file`, `Bun.write`. No Node `fs.promises` shims.
- TS strict, `noUncheckedIndexedAccess`, no `any`.
- File ops via `platform/paths.ts` — no hard-coded `~/.nimbus`.
- Every throw uses `NimbusError(code, ctx)`.
- Workspace IDs are `ulid` (26 chars), case-sensitive.

### Performance
- `create()` <150ms cold (filesystem + scaffold).
- `load()` <50ms warm (JSON parse only).
- `list()` <100ms for up to 50 workspaces (single `readdir` + parallel parse).

### Resource
- `workspace.json` payload <8KB (enforce at write).
- No background watchers in v0.1 (reload-on-next-session pattern).

## 4. Prior Decisions

- **ULID over UUID** — why: sortable by creation time (easier debugging + `list()` natural order); URL-safe; no dashes.
- **Atomic-create via tmp+rename** — why not direct-write: interrupted `init` would leave `SOUL.md` exists but `workspace.json` missing → subsequent `load` crashes. Rename is atomic on POSIX; Windows uses `graceful-fs` retry.
- **JSON (not YAML) for `workspace.json`** — why: single-format simplicity; markdown files carry their own YAML frontmatter via `gray-matter`.
- **No symlink traversal** — why: `load()` refuses symlinked `workspace.json` to prevent T17 cross-workspace leak (META-009).
- **Singleton active-workspace** — why: REPL has single active workspace at a time; switch is explicit; multi-active deferred to v0.4 daemon.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `WorkspaceSchema` Zod + types | rejects missing `schemaVersion`/`id`/`name`; ULID id regex enforced | 30 | — |
| T2 | `workspaceStore.create()` atomic | creates dir + `workspace.json`; crash mid-way leaves no partial dir (test via injected fail) | 60 | T1 |
| T3 | `workspaceStore.load()` | reads + validates; throws `S_CONFIG_INVALID` on malformed `workspace.json`, `S_SCHEMA_MISMATCH` on version drift; `lstat` + `O_NOFOLLOW` to reject symlinked `workspace.json` with `X_PATH_BLOCKED`; resolves paths via `platform/paths` | 40 | T1 |
| T4 | `workspaceStore.list()` | ignores non-conforming dirs (no `workspace.json`); sorted by `lastUsed` desc | 30 | T3 |
| T5 | `workspace.ts` lifecycle wrapper | `create(name)` triggers store + scaffolded SOUL/MEMORY/TOOLS templates | 30 | T2 |
| T6 | `switch(wsId)` updates user config | writes `activeWorkspace` field in `config.json` via SPEC-501 API (stubbed if SPEC-501 not ready) | 10 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/workspace.test.ts`:
  - `describe('SPEC-101: workspace lifecycle')`:
    - `create + load` round-trip preserves all fields.
    - `create` with duplicate name in same `workspacesDir` throws `NimbusError(U_BAD_COMMAND)`.
    - `create` injected failure after dir creation → directory removed (atomic rollback).
  - `list()`:
    - Mixed dir (one valid, one garbage, one missing `workspace.json`) → returns only valid.
    - Sort by `lastUsed` DESC verified.
  - `load()` with `schemaVersion: 99` → throws `S_SCHEMA_MISMATCH`.
  - `load()` with symlinked `workspace.json` → throws `X_PATH_BLOCKED`.

### 6.2 E2E Tests
- `tests/e2e/workspace.test.ts`:
  - `nimbus init foo` + `nimbus workspaces` lists `foo`.
  - Exit code 0 on success; 1 on duplicate.

### 6.3 Performance Budgets
- `create()` <150ms measured via `bun:test` bench.
- `list()` <100ms for 50-workspace fixture.

### 6.4 Security Checks
- Path traversal: `create("../etc")` rejected (`X_PATH_BLOCKED`).
- File mode 0600 on `workspace.json` (Unix asserted).
- `workspace.json` payload >8KB rejected.

## 7. Interfaces

```ts
// workspaceTypes.ts
export const WorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),         // ULID
  name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),    // kebab
  createdAt: z.number().int().positive(),                    // epoch ms
  lastUsed: z.number().int().positive(),
  defaultProvider: z.string().default('anthropic'),
  defaultModel: z.string().default('claude-sonnet-4-6'),
  defaultEndpoint: z.enum(['openai','groq','deepseek','ollama','custom']).optional(),  // v0.1.0-alpha
  defaultBaseUrl: z.string().url().optional(),                                           // required if defaultEndpoint='custom'
}).superRefine((val, ctx) => {
  if (val.defaultEndpoint === 'custom' && !val.defaultBaseUrl) {
    ctx.addIssue({ code: 'custom', path: ['defaultBaseUrl'], message: 'required when defaultEndpoint="custom"' });
  }
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export interface WorkspacePaths {
  root: string
  soulMd: string
  identityMd: string
  memoryMd: string
  toolsMd: string
  sessionsDir: string
  costsDir: string
}

// workspaceStore.ts
export interface WorkspaceStore {
  create(input: { name: string }): Promise<{ meta: Workspace; paths: WorkspacePaths }>
  load(wsId: string): Promise<{ meta: Workspace; paths: WorkspacePaths }>
  list(): Promise<Workspace[]>
  update(wsId: string, patch: Partial<Workspace>): Promise<Workspace>  // not delete yet
}

// workspace.ts
export async function createWorkspace(name: string): Promise<Workspace>
export async function switchWorkspace(wsId: string): Promise<void>
export async function getActiveWorkspace(): Promise<Workspace | null>

// Events (consumed by SessionManager)
export type WorkspaceEvent =
  | { type: 'workspace.created'; wsId: string }
  | { type: 'workspace.switched'; wsId: string }
```

## 8. Files Touched

- `src/core/workspace.ts` (new, ~40 LoC)
- `src/core/workspaceTypes.ts` (new, ~30 LoC)
- `src/storage/workspaceStore.ts` (new, ~110 LoC)
- `tests/core/workspace.test.ts` (new, ~120 LoC)
- `tests/storage/workspaceStore.test.ts` (new, ~100 LoC)

## 9. Open Questions

- [ ] Rename semantics (v0.2): full directory rename vs metadata-only? ASK user before v0.2 start.
- [ ] Default provider/model on create — from global config or per-`init` flag? Default: global config (SPEC-501).

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
- 2026-04-15 @hiepht: extend schema with `defaultEndpoint` + `defaultBaseUrl` (optional) so custom OpenAI-compat endpoints (vLLM, Ollama, Azure, LiteLLM) persist per workspace (Task #31)
