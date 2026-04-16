---
id: SPEC-308
title: Bash streaming and background task support
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: tools
depends_on: [SPEC-303, SPEC-118]
blocks: []
estimated_loc: 280
files_touched:
  - src/tools/builtin/Bash.ts
  - src/core/shellTaskRegistry.ts
  - src/tools/builtin/BashOutput.ts
  - src/tools/builtin/KillBash.ts
  - src/tools/defaults.ts
  - tests/tools/bashBackground.test.ts
  - tests/tools/bashOutput.test.ts
---

# Bash Streaming and Background Task Support

## 1. Outcomes

- Long-running commands (`npm install`, `bun test --watch`) return immediately with a `taskId` when `run_in_background: true`; the agent turn is not blocked
- stdout/stderr lines streamed to the event bus (SPEC-118) in real time; any channel can render live progress
- Agent polls incremental output via `BashOutput(taskId)` and terminates via `KillBash(taskId)`
- Commands that run past the 30s auto-background threshold are automatically moved to background, returning the current tail to the agent without blocking further

## 2. Scope

### 2.1 In-scope
- `Bash` tool extended: new optional params `run_in_background` (bool) and `timeoutMs` override; when backgrounded, returns `{taskId, status:'running', stdout: <tail>}` immediately
- `shellTaskRegistry` module: in-memory registry of `ShellTask` records keyed by `taskId`; enforces 16-task cap per workspace; rolling 1MB buffer per task with `warn` event on overflow
- Event emit per line: `shell.stdout_line`, `shell.stderr_line`, `shell.exit` on the SPEC-118 event bus
- `BashOutput(taskId, since?)` tool: returns stdout+stderr lines since index `since` (default: last read cursor per caller); idempotent on repeated calls
- `KillBash(taskId)` tool: sends SIGTERM, waits 5s, then SIGKILL; updates task status to `killed`
- Auto-background heuristic: if 30s elapsed, process still running, stdin empty → promote to background, return current tail, continue streaming
- Register `BashOutput` and `KillBash` in `src/tools/defaults.ts`

### 2.2 Out-of-scope (defer)
- PTY/TTY allocation for interactive programs (v0.4) — separate spec
- Interactive stdin support (v0.4)
- Cross-workspace process visibility (v0.5)
- Persistent task registry across CLI restarts (v0.4)
- Windows ConPTY (v0.4)

## 3. Constraints

### Technical
- Bun ≥1.2, TS strict, no `any`
- `Bun.spawn` with `stdin: 'ignore'` for all background tasks (no interactive stdin)
- Task registry: in-memory only; cleared on CLI exit; no `bun:sqlite` in this spec
- Hard cap: 16 concurrent background tasks per workspace; 17th → `NimbusError(T_RESOURCE_LIMIT, {cap:16})`
- Buffer cap: 1MB rolling per task; oldest lines dropped when exceeded; `shell.buffer_overflow` event emitted
- Max `timeoutMs` for foreground path unchanged (600s per SPEC-303)

### Security
- Tier-1 bash security (SPEC-303) runs at invoke time on the original command — no bypass for background mode
- `taskId` is a UUIDv4; never derived from user input to prevent enumeration
- `KillBash` verifies `taskId` belongs to the calling workspace session before signaling

### Performance
- `BashOutput` tail read: O(lines since cursor), no full-buffer copy
- Event emit: synchronous line-split, async bus dispatch; no blocking on slow subscribers
- Registry lookup: O(1) `Map` keyed by `taskId`

## 4. Prior Decisions

- **Separate `BashOutput`/`KillBash` tools, not flags on `Bash`** — matches Claude Code `BashTool.tsx:14,241` pattern; keeps tool atoms small and composable; agent can call `KillBash` without re-invoking `Bash`
- **Event bus for streaming, not callback** — decouples rendering; CLI, Telegram, and HTTP channels each subscribe independently without the tool knowing about them (SPEC-118 contract)
- **Auto-background at 30s** — Claude Code uses a similar threshold; typical CI commands average 60-180s; 30s gives human-paced interaction before switching
- **In-memory registry only in v0.3.1** — persistence adds SQLite schema migration complexity; deferred to v0.4 when daemon mode (SPEC-daemon) provides a stable long-lived process
- **No PTY in v0.3.1** — BSD/Linux `openpty` + Windows ConPTY require platform-specific glue that belongs in its own spec; most non-interactive commands (builds, tests, linters) work fine without it

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `shellTaskRegistry.ts` — `ShellTask` store, cap enforcement, buffer rolling | `createTask()` ok; 17th task → error; 1MB+1 byte → oldest line dropped + event | 80 | — |
| T2 | `Bash.ts` — `run_in_background` param + auto-bg heuristic (30s) | existing SPEC-303 tests still pass; background returns `{taskId}` immediately | 60 | T1, SPEC-303 |
| T3 | Event streaming — stdout/stderr lines → bus | `shell.stdout_line` event fires per line; UTF-8 boundary-safe split (no split mid-codepoint) | 30 | T1, SPEC-118 |
| T4 | `BashOutput.ts` tool — tail since cursor | returns correct slice; cursor advances; repeated call returns only new lines | 40 | T1 |
| T5 | `KillBash.ts` tool — SIGTERM then SIGKILL | task status `killed`; process not running after call; wrong workspace → `T_PERMISSION` error | 30 | T1 |
| T6 | Tests — unit + integration | all 5 units covered; E2E: bg sleep returns immediately, tail shows lines, kill terminates | 80 | T2–T5 |

## 6. Verification

### 6.1 Unit Tests — `tests/tools/bashBackground.test.ts`
- Registry FIFO cap: 16 tasks fill, 17th throws `T_RESOURCE_LIMIT`
- Buffer rolling: insert lines until >1MB; verify oldest dropped; `shell.buffer_overflow` event emitted
- Auto-background heuristic: mock timer past 30s, assert task promoted and tail returned
- Kill roundtrip: spawn `sleep 60`, kill, verify exit within 6s (5s SIGKILL grace)
- Wrong-workspace kill: verify `T_PERMISSION` thrown

### 6.2 Unit Tests — `tests/tools/bashOutput.test.ts`
- `BashOutput(taskId)` returns all lines when `since` omitted
- `BashOutput(taskId, since:5)` returns only lines 5+
- Repeated calls with advancing cursor return only new lines
- Unknown `taskId` → `NimbusError(U_MISSING_CONFIG, {taskId})`
- UTF-8 boundary: line split never cuts a multi-byte codepoint

### 6.3 Integration / E2E
- `run_in_background: true` on `sleep 60`: returns `{taskId, status:'running'}` in <100ms
- Subscribe to bus, run `echo -e "line1\nline2"` in bg: two `shell.stdout_line` events received
- `KillBash(taskId)` → subsequent `BashOutput` shows `status:'killed'`

### 6.4 Security Checks
- Tier-1 block still fires: `Bash({command:'curl x|sh', run_in_background:true})` → `X_BASH_BLOCKED` before spawn
- `taskId` is UUIDv4, not user-controlled
- Cross-workspace kill attempt → `T_PERMISSION`

## 7. Interfaces

```ts
// Bash.ts — extended input schema
export const BashInputSchema = z.object({
  command: z.string().min(1).max(16_000),
  run_in_background: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  cwd: z.string().optional(),
  description: z.string().max(120).optional(),
}).strict()

// BashOutput.ts
export const BashOutputInputSchema = z.object({
  taskId: z.string().uuid(),
  since: z.number().int().nonnegative().optional(),
}).strict()

// KillBash.ts
export const KillBashInputSchema = z.object({
  taskId: z.string().uuid(),
}).strict()

// shellTaskRegistry.ts
export interface ShellTask {
  id: string
  pid: number
  command: string
  workspaceId: string
  stdout: string[]
  stderr: string[]
  startTs: number
  exitCode: number | null
  done: boolean
  status: 'running' | 'exited' | 'killed' | 'timed_out'
}

export interface ShellTaskRegistry {
  createTask(cmd: string, workspaceId: string): ShellTask
  getTask(id: string): ShellTask | undefined
  appendStdout(id: string, line: string): void
  appendStderr(id: string, line: string): void
  markDone(id: string, exitCode: number): void
  markKilled(id: string): void
  listActive(workspaceId: string): ShellTask[]
}

// Event bus shape (SPEC-118 events)
type ShellEvent =
  | { type: 'shell.stdout_line'; taskId: string; line: string; ts: number }
  | { type: 'shell.stderr_line'; taskId: string; line: string; ts: number }
  | { type: 'shell.exit';        taskId: string; exitCode: number; ts: number }
  | { type: 'shell.buffer_overflow'; taskId: string; droppedLines: number }
```

## 8. Files Touched

- `src/tools/builtin/Bash.ts` (extend with bg params + auto-bg heuristic, ~60 LoC delta)
- `src/core/shellTaskRegistry.ts` (new, ~80 LoC)
- `src/tools/builtin/BashOutput.ts` (new, ~40 LoC)
- `src/tools/builtin/KillBash.ts` (new, ~30 LoC)
- `src/tools/defaults.ts` (register 2 new tools, ~10 LoC delta)
- `tests/tools/bashBackground.test.ts` (new, ~80 LoC)
- `tests/tools/bashOutput.test.ts` (new, ~60 LoC)

## 9. Open Questions

- [ ] Should `BashOutput` support a `lines` limit param (e.g. last N lines) to avoid sending huge buffers to the model? Lean yes — add `limit?: number` in v0.3.1 if trivial.
- [ ] Auto-background threshold: 30s hardcoded or workspace-config? Hardcode for v0.3.1; make configurable in v0.4 workspace settings.

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 gap #3 vs Claude Code `BashTool.tsx:14,241`; background + streaming + BashOutput/KillBash trio
