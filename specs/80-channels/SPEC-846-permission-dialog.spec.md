---
id: SPEC-846
title: PermissionDialog and per-tool request components
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.4
layer: channels
depends_on: [META-011, SPEC-840, SPEC-830, SPEC-844]
blocks: []
estimated_loc: 500
files_touched:
  - src/channels/cli/ink/components/permissions/PermissionDialog.tsx
  - src/channels/cli/ink/components/permissions/PermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/BashPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/FileWritePermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/FileEditPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/SedEditPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/WebFetchPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/SkillPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/NotebookEditPermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/ExitPlanModePermissionRequest.tsx
  - src/channels/cli/ink/components/permissions/PermissionExplanation.tsx
  - tests/channels/cli/ink/permissions.test.ts
---

# PermissionDialog and Per-Tool Request Components

## 1. Outcomes

- A single `<PermissionDialog>` shell renders for every tool permission request; dispatches to one of 8 per-tool components by tool identity without code duplication.
- User can cycle Yes / "Yes, and don't ask for `<prefix>` again" / No via keyboard; response resolves `UIResult<'allow'|'always'|'deny'>` per the SPEC-830 UIHost contract.
- ExitPlanMode sticky footer keeps Y/A/N options pinned while plan text scrolls; no UI cropping when plan exceeds terminal height.
- `ctrl+e` toggles `<PermissionExplanation>` pane inline without closing the dialog.

## 2. Scope

### 2.1 In-scope

- `PermissionDialog.tsx` — shared shell: rounded top border, `permission` color token (SPEC-840 theme), title byline, hosts any per-tool body + optional explanation pane.
- `PermissionRequest.tsx` — dispatcher: maps `toolName` string to the correct per-tool component; throws `NimbusError(ErrorCode.T_VALIDATION)` on unknown tool identity.
- 8 per-tool components:
  - `BashPermissionRequest` — command display, `getSimpleCommandPrefix()` extraction, destructive-command warning (rm/sudo/dd/mkfs patterns), sandbox hint.
  - `FileWritePermissionRequest` — file path + size/line count preview.
  - `FileEditPermissionRequest` — embeds `<StructuredDiff>` (SPEC-844) inline.
  - `SedEditPermissionRequest` — sed pattern + target file display.
  - `WebFetchPermissionRequest` — URL preview with domain highlight.
  - `SkillPermissionRequest` — skill name + description.
  - `NotebookEditPermissionRequest` — notebook path + cell index.
  - `ExitPlanModePermissionRequest` — plan text in scrollable box; Yes/Always/No footer sticky via `setStickyFooter`.
- `PermissionExplanation.tsx` — toggled pane explaining why the tool needs permission; `ctrl+e` keybinding.
- Response cycle: Tab/arrow keys cycle options; Enter confirms.

### 2.2 Out-of-scope

- Permission rule store writes → reuse SPEC-402 `permissionRuleStore.set()` (called from parent, not this component).
- Diff rendering logic → SPEC-844 `<StructuredDiff>` (imported, not re-implemented here).
- Non-CLI channels → SPEC-831 Telegram UIHost handles its own approval UI.

## 3. Constraints

### Technical

- Bun ≥1.3.5. TypeScript strict, no `any`. Max 400 LoC per file.
- Layer rule (SPEC-833): `channels/cli/` must not import `tools/` directly; tool identity arrives as plain string from the UIHost intent event.
- `ExitPlanModePermissionRequest` uses Ink's `useStdout` rows for sticky footer calculation; no hard-coded row offsets.
- All components are function components; no class inheritance.
- **Border constants (pinned)**: `PermissionDialog` shell uses `borderStyle="round" borderLeft={false} borderRight={false} borderBottom={false}` (matches Claude Code `PermissionDialog.tsx:62`).
- **Bash command prefix safety**: `getSimpleCommandPrefix()` REJECTS any command containing `;`, `&&`, `||`, `|`, `\n`, `$(`, or backtick. When the extracted prefix is ambiguous or contains any of these sequences, the dialog MUST hide the "Always" option and force per-invocation approval. Reason: META-009 T23 rule-injection attack vector.
- **ANSI/OSC stripping**: ExitPlanMode plan body and all `tool_result` text MUST route through the SPEC-843 ANSI-OSC stripper before render to prevent OSC injection into the terminal. Reason: META-009 T22.

### Performance

- First render of dialog ≤16ms (single Ink reconcile pass).
- Explanation pane toggle ≤1 render cycle (state flip only).

### Resource / Business

- 1 dev part-time. No external API calls; pure terminal UI.

## 4. Prior Decisions

- **Dispatcher throws `T_VALIDATION` on unknown tool.** Silent fallback to a generic component would hide wiring bugs; fail-fast surfaces them in dev/QA immediately.
- **`permission` color token, not hardcoded hex.** All theming flows through SPEC-840 `useTheme()` so `NO_COLOR=1` and ANSI-palette modes work without per-component branches.
- **Sticky footer via `setStickyFooter` prop, not absolute positioning.** Ink doesn't support absolute positioning; `setStickyFooter` (Ink 7 API) is the correct pattern for pinned footer rows — matches Claude Code `ExitPlanModePermissionRequest` reference.
- **"Yes, don't ask again" writes rule via callback prop.** Dialog component is pure UI; rule persistence belongs to the caller (UIHost). Matches functional + closures convention.
- **Exact label text**: "Yes, and don't ask again for `<prefix>`" — word order is "ask again for X", NOT "ask for X again". Matches Claude Code `FallbackPermissionRequest.tsx:53-108`.
- **Claude Code references**: `components/permissions/PermissionDialog.tsx:17-71`, `PermissionRequest.tsx:47-82`, `BashPermissionRequest/BashPermissionRequest.tsx:1-535`, `ExitPlanModePermissionRequest/`, `PermissionExplanation.tsx`.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Deps |
|----|------|------------|---------|------|
| T1 | `PermissionDialog.tsx` shell | Renders rounded top border + `permission` token; hosts arbitrary child body | 60 | — |
| T2 | `PermissionRequest.tsx` dispatcher | Maps known tool names to components; unknown → `T_VALIDATION` throw | 40 | T1 |
| T3 | `BashPermissionRequest` | Shows command, prefix, destructive warning on rm/sudo/dd/mkfs | 70 | T1 |
| T4 | `FileWritePermissionRequest` | Shows path + preview line count | 40 | T1 |
| T5 | `FileEditPermissionRequest` | Embeds `<StructuredDiff>` | 40 | T1 |
| T6 | Remaining 5 per-tool components | Each renders tool-specific preview; matches Claude Code counterpart | 110 | T1 |
| T7 | `PermissionExplanation.tsx` + `ctrl+e` toggle | Toggle shows/hides explanation; bound in dialog shell | 40 | T1 |
| T8 | `ExitPlanModePermissionRequest` sticky footer | Y/A/N pinned; plan scrolls independently | 30 | T1 |
| T9 | `permissions.test.ts` | All 8 tool types render; dispatcher throws on unknown; sticky footer asserted | 200 | T2–T8 |

## 6. Verification

### 6.1 Unit Tests

- `tests/channels/cli/ink/permissions.test.ts`: render each of 8 per-tool components via `ink-testing-library`; dispatcher rejects unknown tool name with `T_VALIDATION`; `ctrl+e` toggles explanation; response cycle produces correct `UIResult` values; sticky footer visible when plan body overflows.

### 6.2 Gate B PTY Smoke

- Mock a Write tool event → dialog renders → Tab cycles options → Enter resolves `allow` → tool proceeds (META-011 §6.2 step 3).
- Ctrl-C mid-dialog restores prompt cleanly (META-011 §3.4).

### 6.3 Security Checks

- Bash destructive warning triggers for `rm -rf`, `sudo`, `dd if=`, `mkfs` patterns.
- No tool command text logged to `nimbus.log` (prevent credential/path leakage).

## 7. Interfaces

```ts
// src/channels/cli/ink/components/permissions/PermissionDialog.tsx
export interface PermissionDialogProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  onAllow: () => void;
  onAlways: () => void;
  onDeny: () => void;
  setStickyFooter?: (node: React.ReactNode) => void;
}
export function PermissionDialog(props: PermissionDialogProps): React.ReactElement

// src/channels/cli/ink/components/permissions/PermissionRequest.tsx
export function PermissionRequest(props: PermissionDialogProps): React.ReactElement

// Response resolved to UIHost (SPEC-830 contract):
// UIResult<'allow' | 'always' | 'deny'>

// Extends SPEC-830 UIIntent — new variant for permission requests:
// | { kind: 'permission'; toolName: string; detail: string; allowAlways: boolean }
// UIResult.value narrowed for 'permission' kind: 'allow' | 'always' | 'deny'
// Note: 'allowAlways: false' suppresses the "Yes, and don't ask again" option
// (used when Bash prefix is unsafe/ambiguous per META-009 T23 rule).
```

## 8. Files Touched

- `src/channels/cli/ink/components/permissions/PermissionDialog.tsx` (new, ~60 LoC)
- `src/channels/cli/ink/components/permissions/PermissionRequest.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/permissions/BashPermissionRequest.tsx` (new, ~70 LoC)
- `src/channels/cli/ink/components/permissions/FileWritePermissionRequest.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/permissions/FileEditPermissionRequest.tsx` (new, ~40 LoC)
- `src/channels/cli/ink/components/permissions/SedEditPermissionRequest.tsx` (new, ~20 LoC)
- `src/channels/cli/ink/components/permissions/WebFetchPermissionRequest.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/permissions/SkillPermissionRequest.tsx` (new, ~20 LoC)
- `src/channels/cli/ink/components/permissions/NotebookEditPermissionRequest.tsx` (new, ~20 LoC)
- `src/channels/cli/ink/components/permissions/ExitPlanModePermissionRequest.tsx` (new, ~30 LoC)
- `src/channels/cli/ink/components/permissions/PermissionExplanation.tsx` (new, ~40 LoC)
- `tests/channels/cli/ink/permissions.test.ts` (new, ~200 LoC)

## 9. Open Questions

- [ ] NotebookEdit — show full notebook path or just filename? (depends on typical path lengths)
- [ ] Consider deferring SedEdit + NotebookEdit per-tool components to v0.4.1 to stay within 500 LoC budget (BashPermissionRequest alone is ~535 LoC in Claude Code; 8 variants may push past limit).

## 10. Changelog

- 2026-04-17 @hiepht: draft created by spec-writer-dialogs; synthesized from META-011 Phase D + Claude Code permissions reference
- 2026-04-17 @hiepht: Phase 3 revisions — UIIntent.permission variant added (extends SPEC-830); SPEC-844 dep added; Bash prefix safety rules (META-009 T23); ANSI-OSC strip guard (META-009 T22); border constants pinned; label word order fixed; LoC budget bumped 350→500; SedEdit/Notebook deferral noted in Open Questions.
