---
id: SPEC-301
title: Tool interface + executor
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: tools
depends_on: [META-003]
blocks: [SPEC-302, SPEC-303, SPEC-304, SPEC-103]
estimated_loc: 180
files_touched:
  - src/tools/types.ts
  - src/tools/registry.ts
  - src/tools/executor.ts
  - src/tools/partition.ts
  - src/tools/cancellation.ts
  - tests/tools/executor.test.ts
---

# Tool Interface + Executor

## 1. Outcomes

- Register any tool with a Zod input schema + handler; it's automatically available to the agent loop
- Read-only tools in one LLM turn execute in parallel (≤N concurrent); write tools execute serially after reads
- User cancel (Ctrl+C) aborts all in-flight tools within 500ms via 3-tier cancellation
- Every tool error maps to `NimbusError(T_*)` — the agent loop can feed back deterministically

## 2. Scope

### 2.1 In-scope
- `Tool` interface + `ToolContext` passed to handlers
- `ToolRegistry` (in-memory map; plugins in v0.5)
- `ToolExecutor.run(toolUses, ctx)` — drives a batch from one LLM turn
- `partitionToolCalls(calls, registry)` — splits into `[readOnly[], write[]]` based on `tool.readOnly` flag
- 3-tier cancellation: turn-level AbortController → tool-call AbortController → child process/IO kill hook
- Permission gate call-through (delegated to SPEC-401)
- Zod input validation; failure → `NimbusError(T_VALIDATION, {zodError})`

### 2.2 Out-of-scope (defer to other specs)
- Actual tool implementations (Read/Write/Edit/Bash) → SPEC-302/303/304
- Permission mode semantics → SPEC-401
- Streaming tool output (stdout tail) → v0.3 (`streamingExecutor.ts`)
- MCP tool registration → v0.2

## 3. Constraints

### Technical
- `src/tools/` imports `src/ir/`, `src/permissions/` (interface only), `zod`. NO direct `core/`, `providers/`.
- TypeScript strict, no `any`
- Max 400 LoC per file — split types/registry/executor/partition/cancellation

### Performance
- Executor overhead per call <2ms (excluding handler work)
- Default read concurrency = 10 (configurable)
- Cancellation propagation <500ms p99

## 4. Prior Decisions

- **`readOnly: boolean` flag (not `sideEffects` enum) for v0.1** — plan §6.4 mentions 4 categories (`pure|read|write|exec`) but v0.1 only needs binary split for partition. Upgrading to enum later is additive (default `readOnly:true → sideEffects:'read'`). SPEC-103 loop consumes the same flag. Revisit in v0.2 when MCP tools need granularity.
- **Serial writes, parallel reads** — mirrors Claude Code `toolOrchestration.ts` pattern. Rationale: parallel writes create race conditions on workspace files; parallel reads are safe and fast for large codebases.
- **Zod schemas live on the tool** — single source of truth, also used to generate JSON schema for provider `tools[]` param. No manual duplication.
- **3-tier cancel not 2-tier** — turn AbortController alone cannot kill a child process; handlers install an `onAbort` cleanup that calls `proc.kill('SIGTERM')` then `SIGKILL` after grace period.
- **`dangerous: true` triggers extra confirm in `default` mode only** — `readonly` mode already denies by tool `readOnly:false`; `bypass` mode skips all confirms. `dangerous` is an orthogonal axis used by SPEC-401 gate to demand per-call confirm even when the tool is otherwise allowed by rules.
- **`ToolResult<O>` is the handler-facing shape; executor wraps into `CanonicalBlock{type:'tool_result'}`** — handlers return `{ok:true,output,display?}` or `{ok:false,error,display?}`; executor marshals to IR block at the return boundary. Keeps handler ergonomics (typed `O`) without leaking IR-coupling into every tool.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `Tool` type + `ToolContext` in `types.ts` | `Tool<I,O>` generic; `readOnly:boolean`, `inputSchema:ZodType<I>`, `handler(input,ctx)` | 30 | — |
| T2 | `ToolRegistry` in `registry.ts`: `register`, `get`, `list`, `toJsonSchemas()` | rejects duplicate names with `NimbusError(T_VALIDATION)` | 30 | T1 |
| T3 | `partitionToolCalls` in `partition.ts` | preserves order within each bucket; unknown tool → `T_NOT_FOUND` | 20 | T1 |
| T4 | `ToolExecutor.run()` in `executor.ts` | zod-validate → permission-gate → handler; collect results; reads parallel (p-limit), writes serial | 80 | T1, T3 |
| T5 | `createCancellationScope()` in `cancellation.ts` — turn signal → per-call signal with cleanup hooks | Ctrl+C cancels all in-flight <500ms; `onAbort(fn)` fires once | 20 | — |

## 6. Verification

### 6.1 Unit Tests
- `tests/tools/registry.test.ts`:
  - Register + get round-trip
  - Duplicate name throws `NimbusError(T_VALIDATION)`
  - `toJsonSchemas()` output matches Zod schema for each registered tool
- `tests/tools/partition.test.ts`:
  - `[readA, writeB, readC, writeD]` → `reads:[readA,readC]`, `writes:[writeB,writeD]` preserving order
  - Unknown tool name → `NimbusError(T_NOT_FOUND)`
- `tests/tools/executor.test.ts`:
  - Read-only batch of 5 — all handlers start within 10ms (concurrent)
  - Write batch of 3 — handler B starts only after A resolves (serial)
  - Zod validation failure → result `{isError:true, content:'T_VALIDATION: ...'}`, handler NOT called
  - Handler throws raw → wrapped in `NimbusError(T_CRASH, {cause})`
  - Handler throws `NimbusError(T_PERMISSION)` → surfaced as-is
- `tests/tools/cancellation.test.ts`:
  - Turn signal aborts → all 10 in-flight handlers observe `signal.aborted=true` within 500ms
  - `onAbort` cleanup called exactly once per call

### 6.3 Performance Budgets
- Executor overhead per call <2ms (bench)
- Cancellation propagation <500ms p99 under 10 concurrent handlers

### 6.4 Security Checks
- Tool input MUST pass Zod `.strict()` — extra keys rejected (supply-chain defense against malicious tool definitions)
- Permission gate called BEFORE handler executes — no pre-gate side effects allowed
- Handler errors don't leak through as raw `Error` — always normalized (avoids stack trace leaks)

## 7. Interfaces

```ts
// types.ts
export interface ToolContext {
  readonly workspaceId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolUseId: string
  readonly signal: AbortSignal
  readonly onAbort: (cleanup: () => void) => void
  readonly permissions: PermissionGate  // from SPEC-401
  readonly logger: Logger
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string                          // e.g. 'Read', 'Bash'
  readonly description: string                   // LLM-facing
  readonly inputSchema: z.ZodType<I>
  readonly readOnly: boolean                     // drives partition
  readonly dangerous?: boolean                   // requires confirm in 'default' mode
  handler(input: I, ctx: ToolContext): Promise<ToolResult<O>>
}

export type ToolResult<O = unknown> =
  | { ok: true; output: O; display?: string }
  | { ok: false; error: NimbusError; display?: string }

// registry.ts
export interface ToolRegistry {
  register<I, O>(tool: Tool<I, O>): void
  get(name: string): Tool | undefined
  list(): Tool[]
  toJsonSchemas(): ToolDefinition[]   // for Provider tools[] param
}
export function createRegistry(): ToolRegistry

// partition.ts
export function partitionToolCalls(
  calls: Array<{ toolUseId: string; name: string; input: unknown }>,
  registry: ToolRegistry,
): { reads: typeof calls; writes: typeof calls }

// executor.ts
export interface ToolExecutor {
  run(
    calls: Array<{ toolUseId: string; name: string; input: unknown }>,
    ctx: Omit<ToolContext, 'toolUseId' | 'onAbort'>,
  ): Promise<Array<{ toolUseId: string; block: CanonicalBlock }>>  // tool_result blocks
}
export function createExecutor(opts: {
  registry: ToolRegistry
  readConcurrency?: number       // default 10
}): ToolExecutor

// cancellation.ts
export function createCancellationScope(parent: AbortSignal): {
  signal: AbortSignal
  onAbort(fn: () => void): void
  dispose(): void
}
```

## 8. Files Touched

- `src/tools/types.ts` (new, ~40 LoC)
- `src/tools/registry.ts` (new, ~40 LoC)
- `src/tools/partition.ts` (new, ~25 LoC)
- `src/tools/executor.ts` (new, ~90 LoC)
- `src/tools/cancellation.ts` (new, ~25 LoC)
- `tests/tools/*.test.ts` (new, ~250 LoC)

## 9. Open Questions

- [ ] Concurrency cap configurable per-tool? Default 10 global, override per-tool if needed in v0.2.
- [ ] **Cross-spec inconsistency with SPEC-103**: SPEC-103 loop references `Tool.sideEffects: 'pure'|'read'|'write'|'exec'` (4-category enum per plan §6.4) while SPEC-301 v0.1 uses `Tool.readOnly: boolean`. Deferred to v0.2 — rationale in §4 Prior Decisions. When v0.2 adopts enum, SPEC-103 and SPEC-301 must migrate together (partition logic + loop `sideEffects` filter). Tracking: do NOT implement enum in v0.1; SPEC-103 implementer should consume `readOnly` directly for now.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — commit `readOnly:boolean` v0.1 (upgrade path to `sideEffects` enum in v0.2); document `dangerous` semantics; `ToolResult`→`CanonicalBlock` wrap boundary explicit
- 2026-04-15 @hiepht: round-2 — mark SPEC-103 vs SPEC-301 `readOnly`/`sideEffects` divergence as explicit Open Question with v0.2 migration note
