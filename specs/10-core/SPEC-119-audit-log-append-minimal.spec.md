---
id: SPEC-119
title: Audit log append minimal — JSONL tool + permission events
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: core
depends_on: [META-001, META-003, META-009, SPEC-151, SPEC-601]
blocks: []
estimated_loc: 60
files_touched:
  - src/core/auditLog.ts
  - src/core/auditTypes.ts
  - tests/core/auditLog.test.ts
---

# Audit Log Append Minimal

## 1. Outcomes

- Every tool call + permission decision appends one JSONL line to `${logsDir}/audit/YYYY-MM-DD.jsonl` within <5ms of the event.
- Line payload contains **only** SHA-256 digest of tool input (never raw input) — prevents secrets / prompt content leaking into audit file.
- Day rollover handled by date-derived filename; no background rotation thread.
- Tamper detection (hash-chain) explicitly deferred to v0.2 SPEC-601 upgrade — this spec is "append-only + content-addressable digests" baseline.

## 2. Scope

### 2.1 In-scope
- `AuditEntry` schema: `{ts, sessionId, kind: 'tool_call' | 'permission_decision', toolName, inputDigest, outcome, decisionReason?}`.
- `appendAudit(entry)` — buffered write via `Bun.file().writer()`, flush per-entry (audit volume is low, durability > throughput).
- SHA-256 digest via `Bun.CryptoHasher('sha256')` — pure input bytes hashed; output as hex.
- Directory creation lazy on first write of the day.

### 2.2 Out-of-scope
- Hash-chained entries → v0.2 SPEC-601 hardening (v0.1 tamper-surface is filesystem perms).
- Audit verify CLI + retention + structured query → v0.2-v0.5.

## 3. Constraints

### Technical
- Bun native `Bun.file()` + `Bun.CryptoHasher`.
- TS strict. Zod-validate `AuditEntry` on write (defense against caller passing malformed).
- File mode 0600 on Unix (best-effort WARN on Windows per SPEC-152 pattern).
- Line size cap 4KB; exceed → throw `T_VALIDATION` (prevents pathological-input DoS on log parser).
- All throws `NimbusError(code, ctx)` — misuse codes: `T_VALIDATION`, storage failures `S_STORAGE_CORRUPT`.

### Performance
- `appendAudit()` <5ms p99 (includes digest + buffered write + flush).
- Digest of 1MB input <50ms (sha256 native).

### Resource
- One open file handle per day per process; closed + new handle at midnight boundary (detected on next append).
- No in-memory buffer beyond the single line being composed.

## 4. Prior Decisions

- **Digest-only, never raw input** — why: META-009 T14/T15; raw content can contain API keys / pasted secrets. Digest preserves forensic "what was called" without leak surface.
- **SHA-256, not shorter hash** — why: collision-resistance for forensic comparison across months; 64-hex is cheap at ~300 events/day.
- **Per-day file** — why: `tail -f` / grep-by-date is the common query; rolling-size filenames are less ergonomic.
- **Flush per entry** — why: durability > throughput for security log; audit volume is too low for batching to matter.
- **No hash-chain in v0.1** — why: chain verify needs sidecar checkpoint (SPEC-601 v0.2); fs perms 0600 + pathDenyList are the v0.1 tamper surface.
- **Decouple from event bus** — why: audit MUST persist even if SPEC-118 bus drops events. Direct file-write is the simpler guarantee.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `AuditEntry` Zod schema + types | rejects missing `ts`/`kind`/`toolName`/`inputDigest` | 15 | — |
| T2 | `sha256Hex(input)` helper | deterministic on string + `Uint8Array` inputs; <50ms on 1MB | 10 | — |
| T3 | `appendAudit(entry)` impl | opens day-file lazy; writes JSON line + `\n`; flushes; 0600 mode | 25 | T1, T2 |
| T4 | Day rollover | midnight → next append opens new day file (detected by current date) | 10 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/core/auditLog.test.ts`:
  - `describe('SPEC-119: audit log')`:
    - Append tool_call entry → file exists at `audit/2026-04-15.jsonl`; content parses to equal input.
    - Append permission_decision entry → same.
    - Input digest: `appendAudit({inputDigest: sha256Hex("hello")})` → hex matches known vector `2cf24dba5f...`.
    - Malformed entry (missing `ts`) → throws `NimbusError(T_VALIDATION)`.
    - Line >4KB (crafted `toolName` huge) → throws `T_VALIDATION`.
    - 100 concurrent appends (via `Promise.all`) → all 100 lines present, each is valid JSON (no interleaving corruption — Bun append is line-atomic for <PIPE_BUF; test asserts each line parses).
    - Day rollover: mock clock to 23:59:59, append; advance to 00:00:01, append; verify 2 separate day files.
    - File mode 0600 on Unix (`stat` asserts mode).

### 6.2 E2E Tests
- Covered via SPEC-103 loop test: real tool call → audit file contains matching entry with correct digest of tool input.

### 6.3 Performance Budgets
- `appendAudit()` <5ms p99 on warm file handle (bench 1K iters).
- `sha256Hex(1MB)` <50ms.

### 6.4 Security Checks
- Raw input NEVER written: test creates entry where `toolInput = "sk-ant-secret"` and calls `computeAndAppend()` — assert `grep 'sk-ant' audit-file` returns zero matches.
- Audit dir path validated via `platform/paths.logsDir()` — no user-controlled path injection.
- File mode 0600: read by other user rejected (when applicable; Unix only, Windows degrades gracefully per SPEC-152).
- Writes to audit directory MUST be rejected by pathValidator (SPEC-404) in tools → orthogonal test in permissions spec; referenced here as consumer requirement.

## 7. Interfaces

```ts
// auditTypes.ts
export const AuditEntrySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ts: z.number().int().positive(),                           // epoch ms
  sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),   // ULID
  kind: z.enum(['tool_call', 'permission_decision']),
  toolName: z.string().min(1).max(64),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),           // sha256 hex
  outcome: z.enum(['ok', 'denied', 'error']),
  decisionReason: z.string().max(256).optional(),            // e.g., 'rule-match:Bash(git:*)'
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// auditLog.ts
export async function appendAudit(entry: AuditEntry): Promise<void>
export function sha256Hex(input: string | Uint8Array): string

// Helper that composes digest + appends (most callers want this)
export async function computeAndAppend(params: {
  sessionId: string
  kind: AuditEntry['kind']
  toolName: string
  toolInput: unknown
  outcome: AuditEntry['outcome']
  decisionReason?: string
}): Promise<void>

export const AUDIT_LINE_MAX_BYTES = 4096
```

## 8. Files Touched

- `src/core/auditLog.ts` (new, ~50 LoC)
- `src/core/auditTypes.ts` (new, ~30 LoC)
- `tests/core/auditLog.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Digest input canonicalization — JSON stringify with sorted keys, or direct `JSON.stringify`? v0.1: sorted keys via recursive sort (stable digest even if input key order changes). Document in impl.
- [ ] Compress yesterday's file on new-day rollover? Defer to v0.2 SPEC-601 retention policy.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
