---
id: SPEC-855
title: ink-onboarding-rewrite — nimbus init wizard in Ink (7-step)
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, SPEC-841, SPEC-850]
blocks: []
estimated_loc: 350
files_touched:
  - src/onboard/ink/Onboarding.tsx
  - src/onboard/ink/steps/StepPreflight.tsx
  - src/onboard/ink/steps/StepApiKey.tsx
  - src/onboard/ink/steps/StepProvider.tsx
  - src/onboard/ink/steps/StepLanguage.tsx
  - src/onboard/ink/steps/StepSecurity.tsx
  - src/onboard/ink/steps/StepDone.tsx
  - src/onboard/questions.ts
  - src/onboard/picker.ts
  - tests/onboard/ink/Onboarding.test.tsx
---

# ink-onboarding-rewrite — nimbus init Wizard in Ink (7-Step)

## 1. Outcomes

- `nimbus init` launches a polished 7-step Ink wizard instead of a jarring raw-readline → Ink REPL transition.
- Step N/7 progress indicator visible at all times.
- API key step uses SPEC-841 `<PasswordPrompt>` backed by SPEC-850 `keyPromptCore` — no plaintext echo.
- Provider/language selection uses SPEC-840 `<Tabs>` + `<Pane>` for visual consistency with the rest of the TUI.
- Draft preservation: if user Ctrl-Cs mid-wizard, partially completed answers are stashed; re-running `nimbus init` offers to resume.
- After migration, `src/onboard/questions.ts` and the `picker.ts` usage from the init flow are deprecated (picker.ts kept for other callers per META-011 revision note).

## 2. Scope

### 2.1 In-scope
- New `src/onboard/ink/Onboarding.tsx` (~200 LoC) — root Ink component orchestrating 7 steps.
- 6 step components (~20 LoC each): `StepPreflight`, `StepApiKey`, `StepProvider`, `StepLanguage`, `StepSecurity`, `StepDone`. (Step "theme" from Claude Code's flow is combined into StepDone as a quick selection).
- Step flow: preflight checks → workspace name → API key → provider → language → security mode → done.
- Progress indicator "Step N/7" using `<Byline>` from SPEC-840.
- Draft stash: write partial answers to `~/.nimbus/init-draft.json`; detect on next run and offer resume.
- Deprecate `src/onboard/questions.ts` in the init code path (keep file, mark `@deprecated`; remove in v0.5).
- `src/onboard/picker.ts`: remove from init flow only; keep for other callers (SPEC-903 model picker still uses it until SPEC-847 modal replaces it).

### 2.2 Out-of-scope (defer to other specs)
- API key vault storage logic → SPEC-852 / SPEC-152 (already implemented)
- Provider model discovery → SPEC-903 (already implemented)
- Full modal `/init` re-run → defer to v0.5
- Windows ANSI escape fallback → covered by SPEC-849

## 3. Constraints

### Technical
- Bun ≥1.2; Ink 7 + React 19; TypeScript strict, no `any`.
- Max 400 LoC per file. `Onboarding.tsx` ≤200 LoC; each step ≤30 LoC.
- SPEC-841 `<PasswordPrompt>` used for key entry; MUST call through SPEC-850 `keyPromptCore` (not its own `rl.question`).
- `NO_COLOR` + narrow terminal (<60 cols) both degrade gracefully: linear single-column layout.
- Draft file `init-draft.json` uses `probe-before-write` pattern (HARD RULE §10): never clobber an existing completed workspace.

### Security
- API key entry MUST use SPEC-850 masking — no plaintext echo on TTY.
- `init-draft.json` written mode 0600; never logged.
- If workspace already fully initialized, `nimbus init` must prompt confirmation before overwriting (HARD RULE §10).

### Performance
- Each step renders within 10ms of user advancing.
- Draft stash write: async, non-blocking (fire-and-forget with error log only).

## 4. Prior Decisions

- **Ink wizard, not readline** — eliminates the visual context switch from raw terminal text to Ink REPL on completion. Users complained about the jarring transition in v0.3.10+ testing.
- **7 steps, not 6** — Claude Code's wizard has 6 steps (preflight/theme/api-key/provider/language/security/done). We add "workspace name" as step 2, giving 7. Workspace name is uniquely nimbus-os (multi-workspace support).
- **Step components split per file, not one 200-LoC monolith** — each step has its own test surface; file-size limit respected; Ink component granularity matches Claude Code's `Onboarding.tsx` split.
- **Draft stash vs no-stash** — v0.3.10 QA noted users who Ctrl-C'd mid-init had to restart from scratch. Draft stash eliminates this friction. Stash is a local temp file, not persisted to workspace, so it doesn't violate HARD RULE §10 (it's not user data, it's transient init state).
- **`questions.ts` kept but deprecated** — `nimbus init --no-prompt` (scripted init) still uses `questions.ts` answer-injection pattern; removing it would break CI scripts. Mark `@deprecated`, remove in v0.5 when `--no-prompt` flags are fully wired (v0.1 polish queue item).

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `<Onboarding>` root + step state machine | Advances through 7 steps; "Step N/7" shown; Ctrl-C → draft stash | 80 | SPEC-840 T1 |
| T2 | `StepPreflight` | Checks Bun version, network, existing workspace; shows ✓/✗ per check | 25 | T1 |
| T3 | `StepApiKey` | Uses `<PasswordPrompt>` (SPEC-841) → `keyPromptCore` (SPEC-850); validates non-empty | 25 | T1, SPEC-841, SPEC-850 |
| T4 | `StepProvider` | `<Tabs>` picker: Anthropic / OpenAI-compat / Groq; shows endpoint hint per selection | 25 | T1, SPEC-840 |
| T5 | `StepLanguage` | `<Tabs>` picker: en / vi; sets workspace locale preference | 20 | T1, SPEC-840 |
| T6 | `StepSecurity` | Permission mode selector: `auto` / `manual` / `yolo`; risk note for yolo | 20 | T1, SPEC-840 |
| T7 | `StepDone` | Summary of chosen config; "Press Enter to start nimbus" CTA; cleans up draft stash | 25 | T1-T6 |
| T8 | Draft stash read/write | `probe-before-write`; resume prompt on next run; mode 0600 | 20 | T1 |
| T9 | Unit tests | Each step renders; state advances; Ctrl-C stashes; resume flow | 80 | T1-T8 |

## 6. Verification

### 6.1 Unit Tests
- `tests/onboard/ink/Onboarding.test.tsx` (ink-testing-library):
  - Full happy path: advance through all 7 steps, assert `StepDone` renders.
  - API key step: mock TTY, verify `*` masking chars, not plaintext.
  - Ctrl-C mid-wizard: `init-draft.json` written with progress.
  - Resume: with draft present, initial render shows resume prompt.
  - `NO_COLOR=1`: no box-drawing chars in any step output.
  - cols=50: narrow layout, no Tabs component (linear list).

### 6.2 E2E Tests (Gate B)
- PTY smoke: `nimbus init` in PTY; complete all 7 steps; assert workspace created at expected path.
- Ctrl-C + re-run: draft stash persists; resume dialog shown.
- Existing workspace + `nimbus init`: confirmation dialog shown; workspace NOT overwritten unless confirmed.

### 6.3 Security Checks
- `grep -rn "rl\.question" src/onboard/ink/` = 0 (no raw readline in Ink wizard).
- `init-draft.json` created with mode 0600 (assert in unit test via `Bun.file(...).stat()`).
- Key never logged: pino grep on test output.

## 7. Interfaces

```tsx
// src/onboard/ink/Onboarding.tsx

export interface OnboardingProps {
  /** Draft stash path for resume support */
  draftPath: string;
  /** Called when wizard completes successfully */
  onComplete: (config: InitResult) => void;
}

export function Onboarding({ draftPath, onComplete }: OnboardingProps): React.ReactElement

export interface InitResult {
  workspaceName: string;
  provider: 'anthropic' | 'openai-compat';
  locale: 'en' | 'vi';
  permissionMode: 'auto' | 'manual' | 'yolo';
  /** Vault-stored; not returned in plaintext */
  apiKeyStored: boolean;
}
```

```ts
// Step state machine (internal)
type WizardStep =
  | 'preflight'
  | 'workspace-name'
  | 'api-key'
  | 'provider'
  | 'language'
  | 'security'
  | 'done'
```

## 8. Files Touched

- `src/onboard/ink/Onboarding.tsx` (new, ~80 LoC)
- `src/onboard/ink/steps/StepPreflight.tsx` (new, ~25 LoC)
- `src/onboard/ink/steps/StepApiKey.tsx` (new, ~25 LoC)
- `src/onboard/ink/steps/StepProvider.tsx` (new, ~25 LoC)
- `src/onboard/ink/steps/StepLanguage.tsx` (new, ~20 LoC)
- `src/onboard/ink/steps/StepSecurity.tsx` (new, ~20 LoC)
- `src/onboard/ink/steps/StepDone.tsx` (new, ~25 LoC)
- `src/onboard/questions.ts` (amend: mark `@deprecated`, add JSDoc)
- `src/onboard/picker.ts` (amend: remove from init code path, keep for SPEC-903)
- `tests/onboard/ink/Onboarding.test.tsx` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should `StepPreflight` include a network connectivity check (ping Anthropic endpoint)? (useful but adds latency; make async + non-blocking)
- [ ] `StepDone` "Start nimbus" CTA: launch REPL inline, or exit 0 and let user re-run `nimbus`? (inline preferred for smooth UX; confirm with user)
- [ ] Draft stash TTL: auto-delete after 7 days? (add cron cleanup in SPEC-134)

## 10. Changelog

- 2026-04-17 @hiepht: draft created (Phase 3 gap — eliminates readline→Ink transition; mirrors Claude Code Onboarding.tsx 6-step flow with nimbus 7-step variant)
