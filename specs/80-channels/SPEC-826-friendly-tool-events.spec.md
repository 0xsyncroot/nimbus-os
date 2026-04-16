---
id: SPEC-826
title: Friendly tool-event rendering for user-facing CLI
status: draft
version: 0.2.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.4
layer: channels
depends_on: [SPEC-103, SPEC-801, SPEC-825]
blocks: []
estimated_loc: 210
files_touched:
  - src/channels/cli/toolLabels.ts
  - src/channels/cli/errorFormatCli.ts
  - src/channels/cli/render.ts
  - src/core/toolLabels.ts
  - src/core/turn.ts
  - src/core/loop.ts
  - tests/channels/cli/render.test.ts
  - tests/channels/cli/toolLabels.test.ts
  - tests/core/toolLabels.test.ts
---

# Friendly tool-event rendering for user-facing CLI

## 1. Outcomes

- End-user (non-dev) thấy hành động của agent bằng ngôn ngữ tự nhiên (VN/EN theo `LANG`), không gặp `[TOOL]`, tool name thô, hoặc `call_*` ID.
- Tool error hiển thị dưới dạng câu giải thích + gợi ý kế tiếp; không lộ `T_PERMISSION:needs_confirm` hay stack trace.
- Permission-denied (`T_PERMISSION`) tự động chuyển sang prompt xác nhận inline thay vì in error + để model hallucinate "em đã xong".
- `NIMBUS_VERBOSE=1` (hoặc `--verbose`) trả lại chế độ dev cũ (tool name + toolUseId + ms) cho debug.

## 2. Scope

### 2.1 In-scope
- `toolLabels.ts`: map `toolName + args → { label, verb }` cho 12 tool built-in, song ngữ VN + EN.
- `errorFormatCli.ts`: map `ErrorCode → friendly sentence` chuyên cho tool-event (khác với `observability/errorFormat.ts` vốn lo lỗi top-level CLI).
- `render.ts`: thay 3 dòng in raw bằng `renderToolEvent({ humanLabel, state, detail? })`; không còn reference trực tiếp tới `toolUseId` / `name` ở code path mặc định.
- `turn.ts`: bổ sung field `humanLabel?: string` vào `tool_start` / `tool_end` (optional, backward compat).
- Locale detect: `process.env.LANG` starts-with `vi` → VN; else EN. Override qua `NIMBUS_LANG=vi|en`.

### 2.2 Out-of-scope
- Redesign welcome → SPEC-823 / SPEC-824.
- Wiring confirm() flow into permission-denied → SPEC-825 (bundled cùng release).
- Web/Telegram/Slack channel renderers → channel-specific specs.
- Animated spinner (ora / nanospinner) — dùng static `⋯` prefix, không depend mới.

## 3. Constraints

### Technical
- Bun-native, không add npm dep mới.
- TS strict, no `any`.
- `toolLabels.ts` ≤ 100 LoC; `errorFormatCli.ts` ≤ 60 LoC.
- Render path KHÔNG được đọc `NIMBUS_VERBOSE` trực tiếp — inject qua `createRenderer({ verbose })`.

### Performance
- `formatToolLabel()` O(1) lookup, <0.05ms per call (hot path — chạy mỗi tool invocation).

### Security / privacy
- Label chỉ show path/pattern/hostname, không show raw command stdout hay full URL với query.
- `Bash` command truncate 40 chars + ellipsis.
- `WebFetch` chỉ show `URL.hostname` (no path, no query — tránh lộ token).

## 4. Prior Decisions

- **Map cứng thay plugin** — 12 tool built-in đủ cho v0.1-0.3; MCP/skill tool name hiển thị pattern `skill: {name}` fallback thay vì khai báo riêng. Plugin-provided label → defer v0.4 cùng MCP tool registry.
- **Không ẩn hoàn toàn toolUseId** — audit log (`auditLog.ts`) vẫn ghi đủ; chỉ UI mặc định ẩn. Dev bật `NIMBUS_VERBOSE=1` khi cần repro.
- **Song ngữ chứ không đa ngôn ngữ** — user là VN, fallback EN cho screenshot/issue quốc tế. Framework i18n đầy đủ → defer v0.2 (theo roadmap).
- **`⋯` thay vì spinner animation** — giữ Bun-native, không add `nanospinner`. Terminal async re-render phức tạp hơn lợi ích.
- **Confirm prompt riêng SPEC-825** — tách concern: 826 lo "how to display", 825 lo "how to wire confirm() khi needs_confirm". Cả hai ship v0.3.2.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC |
|----|------|------------|---------|
| T1 | `toolLabels.ts` — map + locale detect | 12 tool × 2 locale, unit test cover 24 case | 80 |
| T2 | `errorFormatCli.ts` — tool error → friendly | 8 ErrorCode mapped, pass-through unknown | 50 |
| T3 | `render.ts` — swap `tool_start`/`tool_end`/`tool_use` | Snapshot test khớp 4 mẫu dưới | 40 |
| T4 | `turn.ts` — add `humanLabel?` field | Type ok, no breakage existing call sites | 5 |
| T5 | Verbose flag wiring (repl.ts → renderer opts) | `NIMBUS_VERBOSE=1 nimbus` vẫn in raw | 10 |

## 6. Verification

### 6.1 Unit tests (`tests/channels/cli/toolLabels.test.ts`)
- `formatToolLabel('Write', {path:'/tmp/bot.py'}, 'vi')` → `"ghi file /tmp/bot.py"`.
- `formatToolLabel('Bash', {command:'ls -la /very/long/path/that/overflows'}, 'en')` → `"running: ls -la /very/long/path..."` (trunc 40).
- `formatToolLabel('WebFetch', {url:'https://api.x.com/v1?token=ABC'}, 'vi')` → `"tải api.x.com"` (no path/query).
- `formatToolError({code:'T_PERMISSION', context:{reason:'needs_confirm'}}, 'vi')` → friendly VN sentence không chứa `T_PERMISSION`.
- Verbose mode: `renderer({verbose:true})` giữ format cũ bit-identical với pre-826 snapshot.

### 6.2 E2E (`tests/e2e/friendlyToolEvents.test.ts`)
- Chạy `nimbus` với fake provider + mock tool invocation, grep stdout: KHÔNG có `[TOOL]`, `call_`, `T_PERMISSION`.
- `NIMBUS_VERBOSE=1` → các token trên phải xuất hiện lại.

### 6.3 Security
- Fuzz 50 random `Bash` commands + `WebFetch` URLs: output len ≤ 80 cols, không leak query params.

## 7. Interfaces

```ts
// toolLabels.ts
export type Locale = 'vi' | 'en';
export type ToolState = 'running' | 'ok' | 'error';

export interface ToolEventView {
  humanLabel: string;       // "ghi file /tmp/bot.py"
  state: ToolState;
  detail?: string;          // "1.2 KB" for ok; friendly error for error
}

export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale;
export function formatToolLabel(
  toolName: string,
  args: Record<string, unknown>,
  locale: Locale,
): string;

// errorFormatCli.ts
export function formatToolError(
  err: { code: ErrorCode; context: Record<string, unknown> },
  locale: Locale,
): string;

// render.ts extension
export interface RendererOptions {
  verbose?: boolean;        // default false; NIMBUS_VERBOSE=1 flips true
  locale?: Locale;
}

// turn.ts additive
export type LoopOutput =
  | { kind: 'tool_start'; toolUseId: string; name: string; args?: Record<string, unknown>; humanLabel?: string }
  | { kind: 'tool_end'; toolUseId: string; ok: boolean; ms: number; errorCode?: string; humanLabel?: string }
  // ...unchanged variants
```

## 8. Label map (authoritative)

| Tool | VN | EN | Arg key |
|------|-----|-----|---------|
| Write | `ghi file {path}` | `writing {path}` | `path` / `file_path` |
| Edit | `sửa {path}` | `editing {path}` | `path` / `file_path` |
| Read | `đọc {path}` | `reading {path}` | `path` / `file_path` |
| Grep | `tìm "{pattern}"` | `searching for "{pattern}"` | `pattern` |
| Glob | `liệt kê {pattern}` | `listing {pattern}` | `pattern` |
| Bash | `chạy: {cmd|40}` | `running: {cmd|40}` | `command` |
| WebSearch | `tìm web: {query}` | `searching web: {query}` | `query` |
| WebFetch | `tải {url.hostname}` | `fetching {url.hostname}` | `url` |
| TodoWrite | `cập nhật plan ({n} mục)` | `updating plan ({n} items)` | `todos.length` |
| MemoryTool | `ghi chú vào memory` | `updating memory` | — |
| AgentTool | `giao việc cho sub-agent` | `delegating to sub-agent` | — |
| Skill | `dùng skill: {name}` | `running skill: {name}` | `skill` / `name` |
| *fallback* | `dùng công cụ: {toolName}` | `using tool: {toolName}` | — |

## 9. Error map (tool-scoped)

| Code | VN | EN |
|------|-----|-----|
| `T_PERMISSION` (needs_confirm) | `Em dừng lại — cần anh cho phép em {action}.` + trigger SPEC-825 confirm | `Paused — I need your permission to {action}.` + confirm |
| `T_PERMISSION` (denied) | `Anh đã chặn em {action}.` | `You denied {action}.` |
| `T_VALIDATION` | `Em gọi công cụ sai cú pháp, đang thử lại.` | `Invalid tool input — retrying.` |
| `T_TIMEOUT` | `Quá lâu, em tạm dừng. Thử lại?` | `Timed out — try again?` |
| `T_NOT_FOUND` | `Không tìm thấy {target}.` | `{target} not found.` |
| `X_BASH_BLOCKED` | `Em không thể chạy lệnh này vì bảo mật: {reason}.` | `Command blocked for safety: {reason}.` |
| `X_PATH_BLOCKED` | `Em không được phép truy cập {path}.` | `Path {path} is off-limits.` |
| `P_NETWORK` | `Mạng chập chờn — em thử lại tự động…` | `Network hiccup — retrying…` |
| *unknown* | `Công cụ lỗi — xem log với \`--verbose\`.` | `Tool failed — run with \`--verbose\` for details.` |

## 10. Render samples

```
# running
⋯ đang ghi file bot.py

# ok
✓ ghi file bot.py (1.2 KB, 38ms giấu mặc định)

# needs_confirm (hands off to SPEC-825)
? Cho em ghi file bot.py vào /home/user/? [Y/n/always/never]

# error (permission denied)
✗ Không ghi được bot.py — anh đã chặn em.

# verbose mode (NIMBUS_VERBOSE=1)
[TOOL] → Write (call_gFYN…) path=/home/user/bot.py
[OK]   call_gFYN… (38ms)
```

## 11. Open Questions

- [ ] Có show duration ở state=ok mặc định không? Proposal: chỉ show nếu >1000ms ("ghi file bot.py (2.4s)"); <1s thì im lặng. Decision: yes, 1s threshold.
- [ ] `always` / `never` của confirm prompt — scope session hay workspace? → SPEC-825 quyết.

## 12. Changelog
- 2026-04-16 @hiepht: draft (bundled with SPEC-824 + SPEC-825 cho v0.3.2 UX polish).
- 2026-04-16 @hiepht: v0.3.4 **Bug A fix** — label map now includes the progressive
  verb inline (VN `đang …`, EN gerund). Removed the hardcoded `đang ` prefix in
  `render.ts` so LANG=C.UTF-8 servers (which default `detectLocale()` to `en`)
  no longer emit the hybrid `đang writing {path}` leak. Added aliases for
  `MultiEdit` / `NotebookEdit` / `Ls` and Bash `cmd` key so registry-emitted
  names never hit the unknown-tool fallback. `loop.ts` now passes `args` on
  every `tool_start` event so the renderer can humanize even when `humanLabel`
  is absent. Error renderer: extract `errorCode` from `ToolResult.content`
  (format `T_xxx: {...ctx}`) into `tool_end` so the friendly formatter can
  pick the per-code sentence instead of the generic "Tool failed —
  run with `--verbose`" dev-hint that leaked to non-dev users.
