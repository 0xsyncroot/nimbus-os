---
id: SPEC-122
title: Session-scoped preferences with mid-session mutation
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: core
depends_on: [SPEC-102, SPEC-104, SPEC-105, SPEC-121]
blocks: []
estimated_loc: 180
files_touched:
  - src/core/sessionManager.ts
  - src/core/prompts.ts
  - src/tools/memoryTool.ts
  - tests/core/sessionPreferences.test.ts
---

# Session-scoped preferences with mid-session mutation

## 1. Outcomes

- Users can say "từ giờ gọi em là X" mid-session; agent sets `agentName: 'X'` for the remainder of the session without a restart.
- Preferences persist in `sessions/{id}/meta.json` under a `preferences` key; reloaded on session resume.
- Active preferences injected into system prompt as a `[SESSION_PREFS]` block between `[IDENTITY]` and the autonomy section (SPEC-105).
- Optional cross-session promotion: user can promote a session pref to `MEMORY.md` via MemoryTool; nimbus prompts once when it detects a "from now on always" intent phrase.

## 2. Scope

### 2.1 In-scope
- `SessionPreferences` type: `{agentName?: string, pronoun?: string, language?: string, voice?: string}`
- Persistence: `sessions/{sessionId}/meta.json` field `preferences` (merged on write, not replaced)
- `sessionManager.ts`: `setSessionPref(sessionId, key, value)` + `getSessionPrefs(sessionId)`
- `prompts.ts`: `buildSystemPrompt()` injects `[SESSION_PREFS]` block when preferences non-empty
- `memoryTool.ts` extension: `setSessionPref` action calls `sessionManager.setSessionPref`
- Intent phrases that trigger `setSessionPref` (via MemoryTool): `từ giờ`, `từ nay`, `luôn luôn`, `always call me`, `call me`, `refer to me as` — matched case-insensitively, agent confirms pref was set
- Cross-session promotion: when user uses "luôn luôn" / "always from now on" phrasing → agent offers (single confirm) to append pref to `MEMORY.md` via SPEC-104 memory loader

### 2.2 Out-of-scope
- UI for listing/resetting all prefs → v0.4 (`nimbus prefs` subcommand)
- Per-workspace pref defaults → v0.4
- `voice` pref wiring to TTS engine → v0.5
- Preference history / undo → v0.4

## 3. Constraints

### Technical
- Pref values: strings only, max 128 chars each; no nested objects
- `meta.json` write is atomic (write-then-rename) to prevent corruption
- `[SESSION_PREFS]` block omitted entirely when `preferences` is empty — no noisy empty block in prompt
- `language` value must be BCP-47 tag (`en`, `vi`, `zh-TW`) or free-form display name (not validated strictly in v0.3)
- No `any` types; strict TypeScript

### Performance
- `setSessionPref` (disk write) <20ms
- Prompt injection (string concat) <1ms

### Resource / Business
- 1 dev part-time
- `meta.json` is a new file alongside existing JSONL session store; no migration needed for v0.1 sessions (file absent = empty prefs)

## 4. Prior Decisions

- **`meta.json` not JSONL append** — preferences are mutable key-value; JSONL append-only is wrong for mutation; a small JSON file is the correct tool for mutable metadata
- **`[SESSION_PREFS]` block placed after `[IDENTITY]`** — identity provides the agent's base persona; prefs narrow it for this session; placing before identity would invert the override priority
- **Merge on write, not replace** — `setSessionPref('agentName', 'X')` should not wipe existing `language: 'vi'`
- **MemoryTool extension over new tool** — avoids tool-count growth; `setSessionPref` is a natural extension of the "manage memory" concept already in MemoryTool
- **Agent offers cross-session promotion, doesn't auto-apply** — auto-applying to `MEMORY.md` without confirmation violates the CLAUDE.md rule against auto-applying FixSkill; same principle: user curates persistent memory

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Zod schema `SessionPreferencesSchema` + `meta.json` read/write helpers | Unit: empty file → `{}`; partial write merges correctly; corrupt file → `NimbusError` | 40 | — |
| T2 | `setSessionPref` + `getSessionPrefs` in sessionManager | Unit: set `agentName` → get returns `{agentName: 'X'}`; persisted after reload | 50 | T1 |
| T3 | `[SESSION_PREFS]` block injection in `prompts.ts` | Unit: non-empty prefs → block present between `[IDENTITY]` and autonomy text; empty → block absent | 30 | T2 |
| T4 | MemoryTool `setSessionPref` action + intent phrase detection | Unit: "call me Linh" → tool called with `agentName: 'Linh'`; cross-session phrase → promotion offer | 60 | T2, T3 |

## 6. Verification

### 6.1 Unit Tests
- `sessionPreferences.test.ts`:
  - `setSessionPref('agentName', 'Linh')` → `getSessionPrefs()` returns `{agentName: 'Linh'}`
  - Second `setSessionPref('language', 'vi')` → `{agentName: 'Linh', language: 'vi'}` (merge)
  - Corrupt `meta.json` → `NimbusError(ErrorCode.S_CONFIG_INVALID)`
  - Session resume (reload from disk) → prefs restored
- `prompts.test.ts`: `buildSystemPrompt` with `{agentName: 'X'}` → output contains `[SESSION_PREFS]` block; empty prefs → no block
- `memoryTool.test.ts`: `setSessionPref` action routes to `sessionManager.setSessionPref`

### 6.2 E2E Tests
- `tests/e2e/session-prefs.test.ts`: spawn `nimbus`, send "gọi tôi là Minh", assert next reply uses "Minh"; resume session → pref still active

### 6.3 Performance Budgets
- `setSessionPref` disk write <20ms (atomic rename pattern)
- Prompt inject <1ms

### 6.4 Security Checks
- Pref values sanitised: strip HTML + ANSI before storing (prevent injection into prompt)
- `meta.json` written with mode `0600`
- `agentName` max 128 chars enforced by Zod — prevents prompt-bloating via long name
- Promotion to `MEMORY.md` requires explicit user confirm; never auto-written

## 7. Interfaces

```ts
export const SessionPreferencesSchema = z.object({
  agentName: z.string().max(128).optional(),
  pronoun: z.string().max(64).optional(),
  language: z.string().max(32).optional(),
  voice: z.string().max(64).optional(),
})
export type SessionPreferences = z.infer<typeof SessionPreferencesSchema>

// sessionManager.ts additions
export function setSessionPref(
  sessionId: string,
  key: keyof SessionPreferences,
  value: string,
): Promise<void>

export function getSessionPrefs(sessionId: string): Promise<SessionPreferences>

// prompts.ts addition
// Returns the [SESSION_PREFS] block string, or '' if prefs empty
export function buildSessionPrefsBlock(prefs: SessionPreferences): string

// memoryTool.ts: new action variant
export type MemoryToolAction =
  | { action: 'read'; scope: 'memory' | 'soul' | 'identity' }
  | { action: 'append'; scope: 'memory'; content: string }
  | { action: 'setSessionPref'; key: keyof SessionPreferences; value: string }
```

## 8. Files Touched

- `src/core/sessionManager.ts` (modify, +50 LoC)
- `src/core/prompts.ts` (modify, +30 LoC)
- `src/tools/memoryTool.ts` (modify, +60 LoC)
- `tests/core/sessionPreferences.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Should `language` pref change the prompt language immediately (e.g., system prompt switches to Vietnamese)? Or is it a hint only? (decide before T3)
- [ ] Promotion offer: inline in reply or a separate confirmation message? (UX decision)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — deferred from v0.2.7, now targeting v0.3
