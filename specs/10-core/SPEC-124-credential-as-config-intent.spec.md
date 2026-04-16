---
id: SPEC-124
title: Credential paste in owned channel → vault save + act
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: core
depends_on: [SPEC-105, SPEC-123, SPEC-152, SPEC-601, SPEC-803]
blocks: []
estimated_loc: 140
files_touched:
  - src/core/promptSections.ts
  - src/core/credentialDetector.ts
  - src/core/prompts.ts
  - src/observability/redactor.ts
  - tests/core/credentialDetector.test.ts
  - tests/core/prompts.test.ts
---

# Credential paste in owned channel → vault save + act

## 1. Outcomes

- User pastes a credential (API key, bot token, OAuth bearer) in their own channel → agent saves it to vault (SPEC-152 AES-GCM), confirms in one line, and proceeds to act — no security-theater refusal.
- `detectCredentials(text)` correctly flags OpenAI `sk-*`, Anthropic `sk-ant-*`, Telegram `NNNN:ABC{35}`, Slack `xoxb-*`, generic JWT, and `Bearer <token>` patterns; does not flag ordinary long alphanumeric strings.
- Matched spans are replaced with `***credential*** (saved to vault)` in session JSONL **before** append (plaintext never written to disk).
- `AUTONOMY_SECTION` carries an explicit `[CREDENTIAL_HANDLING]` clause: paste in own channel = config intent, not leak.

## 2. Scope

### 2.1 In-scope

- **`credentialDetector.ts`** (~30 LoC): pure functions `detectCredentials(text)` + `redactSpans(text, matches)`. Regex patterns: OpenAI `sk-[A-Za-z0-9]{20,}`, Anthropic `sk-ant-[A-Za-z0-9\-_]{20,}`, Telegram `\d{8,12}:[A-Za-z0-9_\-]{35}`, Slack `xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}`, JWT three-part `[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+`, Bearer header `Bearer [A-Za-z0-9\-_.~+/]{20,}`. All require delimiter context (`:`, `sk-` prefix, or structural separator) to avoid false positives.
- **`[CREDENTIAL_HANDLING]` prompt clause** (~35 LoC added to `AUTONOMY_SECTION`): tells the model that a credential pasted by the user in their own channel is configuration intent; correct response shape is save-then-act, not disclaimer. Includes one anti-pattern block (see §4).
- **Session JSONL redaction hook** in `redactor.ts` (~35 LoC): called from the session write path (SPEC-102); replaces every matched span before the JSONL line is appended.
- **`prompts.ts` wiring** (~5 LoC delta): inject `CREDENTIAL_HANDLING_SECTION` into `buildSystemPrompt` after `AUTONOMY_SECTION`.
- **Unit tests** (`credentialDetector.test.ts`, `prompts.test.ts`): positive + negative regex fixtures; redaction span replacement; prompt assembly assertions.

### 2.2 Out-of-scope (v0.4+)

- Auto-connect logic per adapter after vault save — that is SPEC-803 through SPEC-805 territory.
- Credential rotation prompts.
- Multi-value config ingestion (e.g., Slack team + channel + bot token in one paste).
- Provider key slot routing disambiguation (which provider does a given key belong to?).

## 3. Constraints

### Technical

- Bun ≥ 1.2, TypeScript strict, no `any`, max 400 LoC per file.
- Redaction happens **before** JSONL append — the write path in SPEC-102 must call `redactSpans` synchronously before serializing the line.
- Detector is in `core/`, not in each channel — channels must not reimplement their own regex.
- Regex must avoid false positives on regular long alphanumeric strings — all patterns require a structural delimiter (`:`, `sk-` prefix, three-part `.` separator) or a known keyword prefix.
- Agent response must never echo matched spans: not in reply text, not in `tool_use` parameters, not in pino log lines.
- Works in all channels (REPL, HTTP/WS, Telegram, Slack) because redaction is in the session write path, not the channel handler.

### Security

- `credential_detected` event emitted on every match (SPEC-601 observability store) — auditable without carrying plaintext.
- Anti-pattern prompt block is triple-backtick fenced — cannot escape into model instruction.

### Performance

- `detectCredentials` < 1 ms for a 4 KB message (pure regex, no LLM call).
- `redactSpans` < 1 ms for a 4 KB message.

## 4. Prior Decisions

- **Detector in `core/`, not per-channel** — DRY; single regex update point; channels route through core session write path anyway.
- **Redaction on write, not on read** — JSONL must not carry plaintext even transiently. Read-time redaction is too late if the file is fsynced between write and read.
- **Anti-pattern clause in `AUTONOMY_SECTION`, not a new top-level section** — same signal, same fence pattern as SPEC-123. Additional sections dilute attention; the bias fix target is already `AUTONOMY_SECTION`.
- **Don't auto-route to provider key slot** — too many ambiguities (which provider? which workspace?). Prompt section instructs agent to call `MemoryTool.set` / `key set` with one confirmation line; adapters (SPEC-803+) then handle the connect.
- **Verbatim regression example** (user-caught v0.3 bug, 2026-04-16):

  User input: `7236435975:AAE0jYuqg42mjLrk2ijY4So5wxC_F5bhr9o` with message "kết nối với a qua đây đi".

  **Bad response (current v0.3 — security-theater refusal):**
  ```
  Xin lỗi anh, em không thể sử dụng hay xử lý token Telegram thô như vậy.
  Token này là thông tin nhạy cảm...
  ```

  **Good response shape:**
  ```
  Saved to vault under `telegram.botToken`. Connecting...
  [tool_use: telegram.start]
  ```

  The bad shape is the direct trigger for this spec. It is the anti-pattern example placed in `AUTONOMY_SECTION`'s `[CREDENTIAL_HANDLING]` fence.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `credentialDetector.ts` — `detectCredentials` + `redactSpans` | Positive fixtures: Telegram token, OpenAI key, Slack bearer, JWT. Negative: 40-char random alphanum, SHA256 hex. All assertions pass. | 30 | — |
| T2 | `redactor.ts` — session JSONL redaction hook | Given a raw session line containing a Telegram token, `redactBeforeWrite(line)` returns line with span replaced by `***credential*** (saved to vault)`; plaintext absent. | 35 | T1 |
| T3 | `[CREDENTIAL_HANDLING]` clause in `AUTONOMY_SECTION` + wiring in `prompts.ts` | `buildSystemPrompt` output contains `[CREDENTIAL_HANDLING]` header, anti-pattern fence, and "save to vault" instruction. Prompt size < 32 KB. | 40 | — |
| T4 | Unit tests (`credentialDetector.test.ts`, `prompts.test.ts`) | All tests pass under `bun test`. Regex coverage: 6 positive kinds + 4 negative kinds. Prompt shape assertion. | 35 | T1,T2,T3 |

## 6. Verification

### 6.1 Unit Tests

- `tests/core/credentialDetector.test.ts`:
  - Positive: Telegram `\d+:[A-Za-z0-9_\-]{35}`, `sk-abc123…`, `sk-ant-abc123…`, `xoxb-…`, three-part JWT, `Bearer abc…`.
  - Negative: 40-char hex string, UUID, 32-char alphanum without prefix.
  - `redactSpans` replaces each match; positions do not shift for subsequent matches.
- `tests/core/prompts.test.ts`:
  - `buildSystemPrompt` output contains literal `[CREDENTIAL_HANDLING]`.
  - Anti-pattern fence present in output.
  - Injection order unchanged: `SOUL → IDENTITY → SESSION_PREFS → AUTONOMY → CREDENTIAL_HANDLING → SAFETY → UNTRUSTED → TOOL_USAGE → MEMORY → TOOLS_AVAILABLE`.

### 6.2 Regression

- Existing SPEC-123 `AUTONOMY_SECTION` snapshot updated in same commit.
- `bun run spec validate` 0 errors.
- Prompt size assertion: `buildSystemPrompt(…).length < 32_768` bytes.

### 6.3 Smoke

- Fixture prompt: user message `"bot token 7236435975:AAE0jYuqg42mjLrk2ijY4So5wxC_F5bhr9o, kết nối đi"`.
- Assert: `[ASSISTANT]` text output does NOT contain the token literal.
- Assert: session JSONL line contains `***credential*** (saved to vault)` instead of the token.
- Assert: response text contains `"Saved to vault"` or `"vault"` keyword.

## 7. Interfaces

```ts
export interface CredentialMatch {
  kind:
    | 'openai-key'
    | 'anthropic-key'
    | 'telegram-bot-token'
    | 'slack-bearer'
    | 'generic-jwt'
    | 'bearer';
  span: { start: number; end: number };
  redacted: string; // always '***credential*** (saved to vault)'
}

export function detectCredentials(text: string): CredentialMatch[];
export function redactSpans(text: string, matches: CredentialMatch[]): string;

// Called from session JSONL write path (SPEC-102 integration point)
export function redactBeforeWrite(rawLine: string): string;
```

Event emitted on each detection (SPEC-601 observability):
```ts
type CredentialDetectedEvent = {
  type: 'credential_detected';
  kind: CredentialMatch['kind'];
  sessionId: string;
  turnId: string;
  // NO plaintext field — never log the actual credential
};
```

## 8. Files Touched

- `src/core/credentialDetector.ts` (new, ~30 LoC)
- `src/core/promptSections.ts` (~35 LoC delta — add `CREDENTIAL_HANDLING_SECTION`)
- `src/core/prompts.ts` (~5 LoC delta — wire section)
- `src/observability/redactor.ts` (new or extend, ~35 LoC)
- `tests/core/credentialDetector.test.ts` (new, ~35 LoC)
- `tests/core/prompts.test.ts` (~10 LoC delta — new assertions)

## 9. Open Questions

- [ ] Should `redactBeforeWrite` also scrub credential from the `user` turn text before it reaches the provider API call? (Likely yes — tracked for SPEC-124 v0.2 of this spec.)
- [ ] Entropy threshold for `generic-jwt` — three-part Base64url is structurally unambiguous; no entropy check needed. Confirm with security reviewer.

## 10. Changelog

- 2026-04-16 @hiepht: renumbered SPEC-120→SPEC-124 (collision with v0.2 context-compaction implemented spec)
- 2026-04-16 @hiepht: draft — post-v0.3 Telegram paste regression; SPEC-123 action-first bias fix did not cover the credential branch. User-caught live: token pasted in REPL with Vietnamese intent "kết nối với a qua đây đi" → agent emitted security-theater refusal instead of vault-save + connect.
