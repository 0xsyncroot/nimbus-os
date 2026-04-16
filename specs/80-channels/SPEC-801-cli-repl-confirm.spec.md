---
id: SPEC-801
title: CLI REPL + confirm prompt
status: implemented
version: 0.2.7
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-16
release: v0.1
layer: channels
depends_on: [SPEC-103, SPEC-401, SPEC-501, SPEC-601]
blocks: [SPEC-901]
estimated_loc: 400
files_touched:
  - src/channels/cli/repl.ts
  - src/channels/cli/confirm.ts
  - src/channels/cli/colors.ts
  - src/channels/cli/slashCommands.ts
  - src/channels/cli/markdownRender.ts
  - src/channels/cli/render.ts
  - src/channels/ChannelAdapter.ts
  - tests/channels/cli/*.test.ts
---

# CLI REPL + Confirm

## 1. Outcomes

- `nimbus` command drops user into interactive REPL with streaming LLM responses
- Permission `ask` outcomes surface as `[y/N]` prompts; default `N` after 30s timeout
- Slash commands (14 total) `/new /sessions /mode /cost /stop /quit /workspace /provider /model /soul /memory /identity /help /think` functional v0.1. **Semantics: `/stop` cancels the current turn (equivalent to single Ctrl-C); `/quit` exits the REPL (equivalent to double Ctrl-C). `/think` (no arg) enables sticky session reasoning upgrade via SPEC-106 `promoteClass` — next and subsequent turns route to `reasoning` class until `/think off` reverts to workspace default. On enable, prints `[MODEL] Using reasoning model <name> (~5× cost, ~30-90s latency)` banner once. `/help` lists all 14 commands.**
- `NO_COLOR=1` env disables all ANSI codes; screen reader-friendly prefixes (`[ERROR]`, `[WARN]`, `[OK]`)

## 2. Scope

### 2.1 In-scope
- `node:readline` wrapper (Bun re-exports natively per CLAUDE.md §4; first-class, not a shim) with line editing + history
- ANSI color helpers with `NO_COLOR` + TTY detection
- y/n confirm function with timeout + default + escape (Ctrl-C cancels session turn)
- Slash command dispatcher (registry pattern, v0.1 commands listed above)
- Streaming renderer: tokens printed as they arrive; tool-use blocks rendered with colored prefix
- Ctrl-C handling: 1st → cancel current turn (`loop.cancel('user')`); 2nd within 2s → exit REPL

### 2.2 Out-of-scope
- Session compaction UI → v0.2
- Multi-line paste / pager → v0.2
- Advanced command palette / autocompletion → v0.3
- HTTP/WS channel → v0.3
- Telegram/Slack channels → v0.3

## 3. Constraints

### Technical
- No external TUI framework; raw readline + ANSI (keep deps lean)
- `NO_COLOR` spec honored: https://no-color.org/
- Works on cmd.exe, PowerShell, bash, zsh, iTerm (use 16-color safe subset)
- All user text rendered via `logger` or `stdout.write`, never `console.log`

### Performance
- First token render <50ms after arrival
- Slash command dispatch <5ms

### Accessibility
- Prefix tokens: `[OK]`, `[WARN]`, `[ERROR]`, `[ASK]`, `[TOOL]`, `[COST]`
- Never emoji-only status signaling

## 4. Prior Decisions

- **readline (not ink/blessed)** — minimal deps; streaming LLM UX doesn't need full TUI
- **[y/N] default No** — safer for accidental Enter; timeout 30s auto-No
- **2× Ctrl-C to exit** — standard Claude Code pattern; prevents accidental exit mid-turn
- **Slash = single-word lexer** — regex `^/(\w+)(?:\s+(.*))?$`; no complex nesting v0.1

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Color helpers + NO_COLOR | Fixture test: `NO_COLOR=1` strips codes | 30 | — |
| T2 | Confirm prompt (y/N + timeout) | Auto-N after 30s, Ctrl-C rejects | 50 | T1 |
| T3 | Slash dispatcher registry | 12 commands stubbed, dispatch routes correctly | 60 | — |
| T4 | REPL loop (readline + streaming) | Type → submit → stream tokens → next prompt | 70 | T1, T2, T3 |
| T5 | Signal handling (Ctrl-C, SIGTERM) | 1st cancel turn, 2nd exit; SIGTERM graceful close | 40 | T4 |

## 6. Verification

### 6.1 Unit Tests
- `colors.test.ts`: `NO_COLOR=1` → raw text; TTY → ANSI present
- `confirm.test.ts`:
  - "y" → true; "yes" → true; "" (Enter) → false; timeout → false
  - Ctrl-C → throws `NimbusError(U_BAD_COMMAND, {reason: 'cancelled'})`
- `slashCommands.test.ts`: `/mode readonly` dispatches `modeCmd({mode:'readonly'})`
- `repl.test.ts`: mocked stdin sends "hello\n" → loop receives user message

### 6.2 E2E Tests
- `tests/e2e/repl-turn.test.ts`: spawn `nimbus` subprocess; send "hi" → receive streaming reply; `/stop` → exit
- `tests/e2e/repl-mode.test.ts`: `/mode readonly` then ask to write file → `[ASK]` prompt → "N" → denied

### 6.3 Performance Budgets
- First token render latency <50ms

### 6.4 Security Checks
- Tool input logged to obs with payload digest only (no raw args on stdout when a field name matches SENSITIVE_FIELDS)
- SENSITIVE_FIELDS list (shared with SPEC-601 SecurityEvent redactor): `api_key`, `apiKey`, `token`, `password`, `passwd`, `secret`, `authorization`, `bearer`, `cookie`, `session`, `privateKey`, `accessKey`. Names case-insensitive exact match OR substring match for `*_key`, `*_token`, `*_secret`. Values matching regex `^(sk-|ghp_|xoxb-|AIza|eyJ)` also redacted regardless of field name.
- `--dangerously-skip-permissions` flag logs WARN banner at REPL start + requires `NIMBUS_BYPASS_CONFIRMED=1`

## 7. Interfaces

```ts
export interface ReplOptions {
  workspaceId: string
  profile?: string
  skipPermissions?: boolean
}

export function startRepl(opts: ReplOptions): Promise<void>

export function confirm(question: string, opts?: { defaultNo?: boolean; timeoutMs?: number }): Promise<boolean>

export const colors = {
  ok: (s: string) => string,
  warn: (s: string) => string,
  err: (s: string) => string,
  dim: (s: string) => string,
  bold: (s: string) => string,
}

export interface SlashCommand {
  name: string                   // e.g. 'mode'
  description: string
  usage: string
  handler: (args: string, ctx: ReplContext) => Promise<void>
}
export function registerSlash(cmd: SlashCommand): void
export function dispatchSlash(line: string, ctx: ReplContext): Promise<boolean>
// returns false if not a slash command
```

## 8. Files Touched

- `src/channels/cli/repl.ts` (~100 LoC)
- `src/channels/cli/confirm.ts` (~50 LoC)
- `src/channels/cli/colors.ts` (~30 LoC)
- `src/channels/cli/slashCommands.ts` (~70 LoC)
- `tests/channels/cli/` (~200 LoC)

## 9. Open Questions

- [ ] History persistence across sessions (v0.2?)
- [ ] Pager for long outputs (v0.2, `less`-style)

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — add SPEC-501 to depends_on (loads config); clarify `/stop` vs `/quit` vs Ctrl-C semantics; define SENSITIVE_FIELDS list shared with SPEC-601; note `node:readline` is Bun-native per CLAUDE.md §4
- 2026-04-15 @hiepht: add `/think` slash — sticky session reasoning upgrade via SPEC-106 `promoteClass`; prints cost+latency banner on enable; `/help` updated to 14 commands
