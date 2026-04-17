---
id: SPEC-847
title: Modal panels with alt-screen takeover for 8 slash commands
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, SPEC-842, SPEC-849]
blocks: []
estimated_loc: 350
files_touched:
  - src/channels/cli/ink/components/modals/HelpModal.tsx
  - src/channels/cli/ink/components/modals/ModelPickerModal.tsx
  - src/channels/cli/ink/components/modals/CostModal.tsx
  - src/channels/cli/ink/components/modals/MemoryModal.tsx
  - src/channels/cli/ink/components/modals/DoctorModal.tsx
  - src/channels/cli/ink/components/modals/StatusModal.tsx
  - src/channels/cli/ink/components/modals/ExportModal.tsx
  - src/channels/cli/ink/components/modals/CompactModal.tsx
  - tests/channels/cli/ink/modals.test.ts
---

# Modal Panels with Alt-Screen Takeover for 8 Slash Commands

## 1. Outcomes

- 8 slash commands (`/help`, `/model`, `/cost`, `/memory`, `/doctor`, `/status`, `/export`, `/compact`) each open a full alt-screen modal; ESC or `q` exits + restores main screen + prompt cleanly.
- SIGINT mid-modal restores terminal without garbling; guarded against ink#935 scrollback wipe via SPEC-849 `<AltScreen>`.
- `/help` displays 3 tabs (Commands / General / Keybindings) navigable via Tab key; active tab + footer hints visible at all times.
- `/model` picker shows effort sidebar (`○◐●◉`) with left/right arrow cycling; selection commits on Enter.

## 2. Scope

### 2.1 In-scope

- 8 modal components, each wrapping SPEC-849 `<AltScreen>`:
  - `HelpModal` — 3-tab layout (Commands / General / Keybindings) using SPEC-840 `<Tabs>`; max-height `Math.floor(rows / 2)`.
  - `ModelPickerModal` — model list with left/right effort sidebar (`○◐●◉` levels); full-screen height.
  - `CostModal` — table view of today/week/session spend; wraps `src/cost/dashboard.ts` data.
  - `MemoryModal` — markdown browser of `MEMORY.md` with pagination; full-screen.
  - `DoctorModal` — re-renders `CheckRow[]` from `src/cli/debug/doctor.ts` logic; full-screen.
  - `StatusModal` — version / session ID / cwd / MCP panel; full-screen.
  - `ExportModal` — filename input + format picker (markdown / JSON); full-screen.
  - `CompactModal` — summary preview before compaction; full-screen.
- Each modal: header (title + byline) + scrollable body + footer keybinding hints.
- ESC / `q` keybinding handled inside each modal via SPEC-849 `useKeybindings`.

### 2.2 Out-of-scope

- `/help` slash command routing → SPEC-842 autocomplete dispatcher triggers modal open.
- Fullscreen transcript rewind (`ctrl+o`) → deferred to v0.5 (META-011 §2.2).
- In-TUI search highlight → deferred to v0.5.
- Mouse selection / hit-testing → deferred to v0.5.

## 3. Constraints

### Technical

- Bun ≥1.3.5. TypeScript strict, no `any`. Max 400 LoC per file.
- All modals MUST use SPEC-849 `<AltScreen>` — direct DEC 1049 writes from modals are forbidden.
- Layer rule (SPEC-833): modals may import `src/cost/dashboard.ts` and `src/cli/debug/doctor.ts` only through their exported types/functions (no deep internal imports).
- `HelpModal` max-height = `Math.floor(rows / 2)` to match Claude Code `HelpV2.tsx:20` pattern; all other modals use full terminal height.
- SIGINT during any modal: SPEC-849 `<AltScreen>` SIGINT guard handles restore — modals must not install competing SIGINT handlers.
- `MemoryModal` renders MEMORY.md content through the SPEC-843 ANSI-OSC stripper before display. Verification: fixture MEMORY.md containing `\x1b[2J\x1b[H` must NOT wipe the terminal when the modal opens.
- `DoctorModal` memoizes the `runDoctor()` result for the modal's lifetime; user keypress `r` forces a re-run. `src/cli/debug/doctor.ts` must expose a pure-logic function (not direct stdout writes); if it currently writes to stdout, refactor into a returned `CheckRow[]` as part of this SPEC's T4 task.
- `<AltScreen>` scrollback-wipe guard is verified in SPEC-849 `meta-ux.test.ts` (cross-ref §6).
- Slash command routing that opens modals is provided by SPEC-842 (hence dependency).

### Performance

- `/help` modal first paint ≤30ms (META-011 §3.2 budget).
- Modal mount/unmount leaves zero ANSI artifact; verified by PTY smoke string assertion.

### Resource / Business

- 1 dev part-time. No network calls from modals; data sourced from local stores.

## 4. Prior Decisions

- **All modals share `<AltScreen>` from SPEC-849, not inline DEC 1049 writes.** Centralising alt-screen logic prevents the ink#935 scrollback wipe from appearing in multiple modals independently. One guard, many consumers.
- **`DoctorModal` re-renders existing `doctor.ts` logic, no duplicate check code.** The check functions already exist; rendering them through Ink is a view concern only. Avoids logic drift between CLI `nimbus doctor` text output and TUI modal.
- **`ModelPickerModal` mirrors Claude Code `ModelPicker.tsx:39-447`.** Effort sidebar `○◐●◉` is a known UX affordance from Claude Code research; matching it gives visual parity (META-011 §1).
- **Full-screen for 7 modals, half-height for `/help`.** Claude Code `HelpV2` uses half-height to keep context visible; the other modals are focused tasks where full-screen is appropriate.
- **Claude Code references**: `HelpV2/HelpV2.tsx:20-183`, `ModelPicker.tsx:39-447`, `Settings/Status.tsx`, `Settings/Usage.tsx`, `components/ExportDialog.tsx:25`, `components/CompactSummary.tsx`, `screens/Doctor.tsx`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `HelpModal` — 3 tabs + half-height | Tab key cycles tabs; keybinding hints in footer; `rows/2` height | 80 | — |
| T2 | `ModelPickerModal` — picker + effort sidebar | Left/right cycles `○◐●◉`; Enter commits selection | 80 | — |
| T3 | `CostModal`, `MemoryModal` | Cost table renders from `dashboard.ts`; memory paginates MEMORY.md | 80 | — |
| T4 | `DoctorModal`, `StatusModal` | CheckRow array from `doctor.ts`; Status panel shows version/session/cwd | 60 | — |
| T5 | `ExportModal`, `CompactModal` | Filename input + format picker; compact summary preview | 50 | — |
| T6 | `modals.test.ts` — smoke suite | All 8 modals mount; ESC exits; SIGINT path asserted via mock | 200 | T1–T5 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/modals.test.ts`: each modal renders non-empty `lastFrame()`; ESC unmounts; `q` unmounts; `/help` tab switch via Tab key; `/model` effort cycle via left/right; SIGINT mock calls restore.

### 6.2 Gate B PTY Smoke

- Slash command cycle: `/help` → Esc → `/model` → picker → Esc → main prompt visible (META-011 §6.2 step 2).
- `ctrl+l` redraws cleanly after modal exit (META-011 §6.2 step 4).
- SIGINT mid-modal: terminal remains usable (META-011 §3.4).

### 6.3 Performance Budget

- `/help` first paint ≤30ms: measured in `modals.test.ts` bench block via `performance.now()`.

## 7. Interfaces

```ts
// Each modal accepts a common close callback:
export interface ModalProps {
  onClose: () => void;
}

// HelpModal tab IDs:
export type HelpTab = 'commands' | 'general' | 'keybindings';

// ModelPickerModal effort levels:
export type EffortLevel = 'none' | 'low' | 'medium' | 'high';
// Glyphs: none=○, low=◐, medium=●, high=◉

// Example:
export function HelpModal(props: ModalProps): React.ReactElement
export function ModelPickerModal(
  props: ModalProps & {
    models: string[];
    currentModel: string;
    onSelect: (model: string, effort: EffortLevel) => void;
  }
): React.ReactElement
```

## 8. Files Touched

- `src/channels/cli/ink/components/modals/HelpModal.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/modals/ModelPickerModal.tsx` (new, ~80 LoC)
- `src/channels/cli/ink/components/modals/CostModal.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/modals/MemoryModal.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/modals/DoctorModal.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/modals/StatusModal.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/modals/ExportModal.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/modals/CompactModal.tsx` (new, ~20 LoC)
- `tests/channels/cli/ink/modals.test.ts` (new, ~200 LoC)

## 9. Open Questions

- [ ] Should `/memory` modal support editing MEMORY.md inline, or read-only only? (read-only for v0.4; edit deferred)
- [ ] `/export` — support clipboard export (OSC 52) in addition to file? (OSC clipboard deferred to v0.5 per META-011 §2.2)

## 6. Cross-References

- SPEC-842: slash command dispatcher that triggers modal open.
- SPEC-843: ANSI-OSC stripper used by MemoryModal.
- SPEC-849: `<AltScreen>` component + `meta-ux.test.ts` scrollback-wipe guard.

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-dialogs; synthesized from META-011 Phase D + Claude Code modal research
- 2026-04-17 @hiepht: detail-pass — added SPEC-842 to depends_on; MemoryModal ANSI-OSC strip guard + fixture test; DoctorModal memoize+keypress-r re-run + pure-function refactor note; AltScreen scrollback-wipe guard cross-ref to SPEC-849 meta-ux.test.ts; added §6 cross-references
