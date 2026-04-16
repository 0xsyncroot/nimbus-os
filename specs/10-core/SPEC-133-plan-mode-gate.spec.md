---
id: SPEC-133
title: Plan-mode gate — tool whitelist + ExitPlanMode approval flow
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: core
depends_on: [SPEC-401, SPEC-132, SPEC-301, SPEC-103]
blocks: []
estimated_loc: 180
files_touched:
  - src/permissions/mode.ts
  - src/tools/enterPlanMode.ts
  - src/tools/exitPlanMode.ts
  - src/core/loop.ts
  - src/tools/defaults.ts
  - tests/permissions/planMode.test.ts
  - tests/tools/exitPlanMode.test.ts
---

# Plan-mode gate — tool whitelist + ExitPlanMode approval flow

## 1. Outcomes

- Agent entering plan mode is hard-restricted to `Read`, `Grep`, `Glob`, `TodoWrite`, `ExitPlanMode` — all other tools refused with `T_PERMISSION`
- `ExitPlanMode({plan})` surfaces the plan to the user and blocks the tool cycle until explicit approval, rejection, or refinement
- User approval transitions mode back to `default` or `acceptEdits`; rejection cancels and stays in `plan`; refinement re-enters with a hint injected into context
- No write or exec tool leaks during plan mode (security property enforced at executor, not per-tool)

## 2. Scope

### 2.1 In-scope

- Enable `plan` mode in `src/permissions/mode.ts` (currently stubbed with `U_MISSING_CONFIG` throw)
- `EnterPlanMode()` tool — idempotent; returns ACK string; transitions mode to `plan`
- `ExitPlanMode({plan})` tool — emits `plan.proposed` event, blocks tool cycle until `plan.decision` event received
- Loop gate in `src/core/loop.ts` — checked at executor entry before any tool dispatch; non-whitelist tool → `NimbusError(T_PERMISSION)` with hint `"Exit plan mode first"`
- `/mode plan` slash routing already dispatches to mode registry; enabling the mode here completes the wiring
- Sub-agent permission narrowing: when parent session is `plan`, sub-agents (SPEC-130) inherit via `permission.lattice.narrow()` — write/exec blocked across the tree

### 2.2 Out-of-scope (defer)

- Plan editing UI (inline diff of plan text) — v0.4
- Multi-plan queue (multiple pending plans) — v0.4
- `acceptEdits` mode implementation — SPEC-404

## 3. Constraints

### Technical

- Whitelist enforced at executor level in `loop.ts`, not inside individual tools — defense in depth; a tool that forgets to self-check would otherwise leak
- `ExitPlanMode` returns only after user decision — synchronous within the tool cycle (matches Claude Code `ExitPlanModeV2Tool` semantic); async/event-driven would race with the next user message
- Plan text rendered to user via channel render path (SPEC-802 `ChannelAdapter`) — no raw stdout
- Plan string from `ExitPlanMode` treated as agent-generated content: rendered as one-shot display, never re-injected as an instruction source
- Bun-native, TS strict, no `any`, max 400 LoC per file

### Performance

- Gate check in `loop.ts` <0.1ms (map lookup, no I/O)
- `ExitPlanMode` event round-trip budget ≤30 s (user-driven; no hard timeout in v0.3.1)

### Security

- `T_PERMISSION` error on blocked tool must also emit a `SecurityEvent` to audit log (SPEC-601 hook, consistent with existing gate behaviour in SPEC-401)
- Plan string max 8 000 chars (Zod enforced) to prevent oversized render

## 4. Prior Decisions

- **Gate at executor, not via tool flag** — self-checked tools leak when a tool author forgets. Pattern follows Claude Code `src/hooks/toolPermission/PermissionContext.ts:217-227`; executor is the single chokepoint
- **ExitPlanMode synchronous** — async approval would allow the agent to continue calling tools while awaiting user input; the tool cycle must truly block until the user decides
- **Plan text is untrusted-wrapped** — agent-generated plan shown to user as display content, not fed back as an instruction. Prevents prompt-injection via crafted plan strings
- **Whitelist by tool name string** — SPEC-301 `Tool.sideEffects` `'pure'|'read'|'write'|'exec'` would also work, but name-based whitelist is explicit and auditable; no silent side-effect mis-classification can widen the gate

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|-----------|---------|---------|
| T1 | Enable `plan` in `mode.ts` + implement `isAllowedInPlanMode(toolName)` | `/mode plan` no longer throws; whitelist unit-testable | 30 | — |
| T2 | `enterPlanMode.ts` — tool impl + register in `defaults.ts` | tool callable, returns ACK, mode transitions to `plan` | 35 | T1 |
| T3 | `exitPlanMode.ts` — emit `plan.proposed`, await `plan.decision` via event bus (SPEC-118) | blocks until event resolves; returns decision string | 55 | T1 |
| T4 | Loop gate in `loop.ts` — pre-dispatch whitelist check; `T_PERMISSION` + security event on violation | non-plan tool in plan mode → error; whitelisted tool passes | 25 | T1, T3 |
| T5 | Tests — unit + security + E2E path | gate, happy path, decision events all covered | 80 | T1–T4 |

## 6. Verification

### 6.1 Unit Tests

- `tests/permissions/planMode.test.ts`: `isAllowedInPlanMode` returns true for each whitelisted tool; returns false for `Bash`, `Write`, `Edit`; mode transition `default → plan → default` round-trip
- `tests/tools/exitPlanMode.test.ts`: `plan.proposed` event emitted with correct payload; tool blocks until `plan.decision` resolved; `approve` / `reject` / `refine` branches each exercised

### 6.2 E2E Tests

- User sends `/mode plan` → agent calls `Read` successfully → agent calls `Bash` → receives `T_PERMISSION` error with hint
- Agent calls `ExitPlanMode({plan: "..."})` → user approves → mode returns to `default` → agent proceeds with write tool

### 6.3 Security Checks

- `Bash` in plan mode → `T_PERMISSION` + `SecurityEvent` in audit log (SPEC-601)
- `Write` in plan mode → same
- Plan string of 8 001 chars → Zod rejects before emit
- Sub-agent inherits `plan` mode; sub-agent `Write` attempt → `T_PERMISSION`

## 7. Interfaces

```ts
// Tool input schemas
const EnterPlanModeInput = z.object({});
const ExitPlanModeInput = z.object({
  plan: z.string().min(1).max(8000),
});
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInput>;
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>;

// Events (SPEC-118 event bus topics)
interface PlanProposedEvent {
  topic: 'plan.proposed';
  plan: string;
  turnId: string;
}
interface PlanDecisionEvent {
  topic: 'plan.decision';
  decision: 'approve' | 'reject' | 'refine';
  refineHint?: string;
  targetMode?: 'default' | 'acceptEdits';
}

// Whitelist (enforced in loop.ts)
const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'TodoWrite', 'ExitPlanMode',
]);
```

## 8. Files Touched

- `src/permissions/mode.ts` (modify — enable `plan` mode, add `isAllowedInPlanMode`, ~+30 LoC)
- `src/tools/enterPlanMode.ts` (new, ~35 LoC)
- `src/tools/exitPlanMode.ts` (new, ~55 LoC)
- `src/core/loop.ts` (modify — add gate before tool dispatch, ~+25 LoC)
- `src/tools/defaults.ts` (modify — register two new tools, ~+6 LoC)
- `tests/permissions/planMode.test.ts` (new, ~45 LoC)
- `tests/tools/exitPlanMode.test.ts` (new, ~35 LoC)

## 9. Open Questions

- [ ] Should `refine` decision re-inject `refineHint` as a system turn or a user turn? (ask before T3 impl)
- [ ] Hard timeout for `ExitPlanMode` await — add in v0.3.2 or leave user-driven? (defer)

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 autonomy patch; gap #1 vs Claude Code analyst gap analysis. EnterPlanMode/ExitPlanMode ported from Claude Code `src/tools/EnterPlanModeTool/` + `ExitPlanModeTool/` semantics. nimbus TodoWrite is not a gate — this spec adds the actual permission barrier.
