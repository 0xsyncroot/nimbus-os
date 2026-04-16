---
id: SPEC-130
title: Sub-agent runtime + coordinator + permission lattice
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: core
depends_on: [SPEC-103, SPEC-118, SPEC-119, SPEC-401, SPEC-601, META-003, META-004]
blocks: [SPEC-131]
estimated_loc: 380
files_touched:
  - src/core/subAgent/runtime.ts
  - src/core/subAgent/coordinator.ts
  - src/core/subAgent/permissions.ts
  - tests/core/subAgent/runtime.test.ts
  - tests/core/subAgent/coordinator.test.ts
---

# Sub-agent runtime + coordinator + permission lattice

## 1. Outcomes

- Parent agent can spawn sub-agents to handle parallel tasks (research, investigation); each sub-agent runs its own turn loop
- Zero-cost spawn via async in-process coroutine (no Worker/subprocess overhead for v0.3)
- Parent cancellation cascades to all sub-agents <100ms via AbortSignal.any
- Permission lattice: sub-agent perms ⊆ parent perms, never widens
- Heartbeat + dead-agent detection prevents zombie sub-agents

## 2. Scope

### 2.1 In-scope

- `SubAgentRuntime.spawn(opts)` — creates sub-agent, wraps SPEC-103 `runTurn` with child AbortController (child of parent's turnAbort via `AbortSignal.any`)
- Coordinator: registry `Map<SubAgentId, SubAgentHandle>`, spawn budget (max 4 concurrent per parent, max depth 2)
- Heartbeat: sub-agent emits `heartbeat` every 3s; coordinator flags dead after 10s silence → raises `Y_SUBAGENT_CRASH`, cancels AbortController, reports stub result
- Cancellation cascade: parent cancel → all children cancel; tested with nested spawn
- Permission lattice (`src/core/subAgent/permissions.ts`): `narrow(parent, opts) → ChildPermissions` — intersects bash allowlist, subtracts denied tools, mode can only move DOWN (readonly→readonly, default→readonly|default, never→bypass)
- Feature flag `subAgent.backend = 'inproc' | 'worker' | 'subprocess'` — only `'inproc'` implemented v0.3, other backends throw `U_NOT_IMPLEMENTED`
- Iteration cap reuse from SPEC-103 (max 30 turns per sub-agent)

### 2.2 Out-of-scope (v0.4+)

- Bun Worker backend (v0.4 — JS heap isolation)
- Subprocess backend (v0.5 — OS-level, cgroups)
- Multi-terminal tmux pane display (v0.4 daemon mode)
- Sub-sub-agent depth > 2 (security — prevents fork bomb)

## 3. Constraints

### Technical
- Bun-native, TS strict, no `any`, max 400 LoC per file
- Child AbortController MUST be `AbortSignal.any([parent, child])` — single cancel root
- Spawn depth MUST be tracked; throw `T_SPAWN_DEPTH_EXCEEDED` at depth 3

### Performance
- Spawn <5ms (just coroutine start, no OS process)
- Heartbeat overhead <1% CPU
- Cancellation cascade <100ms end-to-end (per SPEC-103 guarantee)

### Security
- Permission lattice enforced at `canUseTool` composition, never by re-reading rules
- Bash allowlist on spawn: INTERSECTION only with parent's, default empty (explicit opt-in)

## 4. Prior Decisions

- **Async in-process over Worker/subprocess** — Claude Code ref (src/tools/shared/spawnMultiAgent.ts) uses same pattern; v0.3 has no tmux UX, pay zero overhead; upgrade path via feature flag
- **Trade-off accepted**: misbehaving sub-agent can starve event loop → mitigated by iteration cap (30) + spawn budget (4) + heartbeat watchdog
- **Heartbeat 3s interval, 10s timeout** — industry-standard for local daemons (systemd default); conservative vs 1s to avoid noise
- **Max depth 2** — prevents fork bomb; power users can request deeper via sub-agent's own AgentTool, but v0.3 hard cap
- **Permission lattice via function composition** — single source of truth is SPEC-401; sub-agent's canUseTool wraps parent's gate with extra filter, no new rule engine
- **Feature flag for backend** — forward-compatible for v0.4 Worker + v0.5 subprocess without spec churn

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | `SubAgentRuntime.spawn()` wraps runTurn with child AbortController | spawn+cancel roundtrip test | 140 | — |
| T2 | Coordinator registry + spawn budget + depth guard | 5th spawn throws, depth-3 throws | 100 | T1 |
| T3 | Heartbeat loop + dead-agent detector | 10s silence → Y_SUBAGENT_CRASH | 50 | T2 |
| T4 | Cancellation cascade wiring via AbortSignal.any | parent cancel → all children cancel | 30 | T1 |
| T5 | Permission lattice `narrow()` + tests | readonly ws spawns readonly child only | 60 | — |

## 6. Verification

### 6.1 Unit Tests
- Spawn/cancel roundtrip, depth guard, budget guard
- Heartbeat timeout detection (mock timer)
- Lattice: parent readonly + child request default → throws; parent default + child readonly → OK

### 6.2 E2E Tests
- Nested spawn cancel cascade (parent → 2 children → child → grandchild at depth 2, cancel parent, all abort <100ms)

### 6.3 Security Checks
- Sub-agent bash allowlist ⊆ parent's (intersection test)
- Sub-agent cannot bypass parent deny list
- Depth-3 spawn refused with `T_SPAWN_DEPTH_EXCEEDED`

## 7. Interfaces

```ts
interface SubAgentOpts {
  parentId: AgentId;
  prompt: string;
  mode?: PermissionMode;          // can only narrow from parent
  narrowBash?: string[];          // intersect only
  denyTools?: ToolName[];         // subtract only
  timeoutMs?: number;
  systemPrompt?: string;          // override; defaults to parent's SOUL
}

interface SubAgentHandle {
  id: SubAgentId;
  parentId: AgentId;
  depth: number;
  abortController: AbortController;
  mailboxId: string;
  spawnedAt: number;
}

interface SubAgentRuntime {
  spawn(opts: SubAgentOpts): Promise<SubAgentHandle>;
  cancel(id: SubAgentId): Promise<void>;
  cancelAll(parentId: AgentId): Promise<void>;
  list(parentId: AgentId): SubAgentHandle[];
}
```

## 8. Files Touched

- `src/core/subAgent/runtime.ts` (new, ~140 LoC)
- `src/core/subAgent/coordinator.ts` (new, ~100 LoC)
- `src/core/subAgent/permissions.ts` (new, ~60 LoC)
- `tests/core/subAgent/runtime.test.ts` (new, ~80 LoC)
- `tests/core/subAgent/coordinator.test.ts` (new, ~50 LoC)

## 9. Open Questions

- [ ] Should depth-2 hard cap be configurable? (defer — security default)
- [ ] Per-sub-agent cost budget (separate from parent)? (defer v0.3.1)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on Phase 1 analyst report (async in-process recommendation)
