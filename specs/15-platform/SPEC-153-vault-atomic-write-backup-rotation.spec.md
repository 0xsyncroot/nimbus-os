---
id: SPEC-153
title: Vault atomic-write + timestamped backup rotation
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-17
updated: 2026-04-17
release: v0.3.9
layer: platform
pillars: [P1, P3]
depends_on: [SPEC-152, META-009]
blocks: [SPEC-904, SPEC-505]
estimated_loc: 50
files_touched:
  - src/platform/secrets/fileFallback.ts
  - tests/platform/secrets/fileFallback.test.ts
---

# Vault atomic-write + timestamped backup rotation

## 1. Outcomes

- `secrets.enc` is never corrupted mid-write: writes go tmp-file → fsync → rename → old file preserved as `secrets.enc.bak-{ts}` keeping last 3 generations.
- Kill -9 between any two I/O syscalls leaves the vault either at the prior valid envelope OR at the freshly-written valid envelope. No half-written JSON.
- Downstream specs (SPEC-904 interactive key manager, SPEC-505 boot recovery) can call `saveData` with zero additional guard-rails around atomicity.

## 2. Scope

### 2.1 In-scope
- Rewrite `saveData()` in `src/platform/secrets/fileFallback.ts` to use the tmp+fsync+rename sequence.
- Add backup rotation: before rename, move current `secrets.enc` → `secrets.enc.bak-{iso-ts}`, prune to last 3 `*.bak-*` by mtime.
- Preserve mode `0o600` on both tmp and final file.
- Add regression test simulating crash between tmp write and rename.

### 2.2 Out-of-scope (defer)
- Atomic-write for `.vault-key` itself (handled once by init; separate threat model) → defer to v0.4 if needed.
- Encrypted backups (the `.bak` files ARE the encrypted envelope — same protection).
- Moving to bun:sqlite storage → v0.5 migration path (see META-006).

## 3. Constraints

### Technical
- Must use `node:fs/promises` `rename` (atomic on POSIX, near-atomic on NTFS). No third-party atomic-write lib.
- Tmp file lives in same directory as target (same filesystem — required for POSIX rename atomicity).
- Max file mode drift between tmp and final: zero — write tmp with `{ mode: 0o600 }` from the start.

### Performance
- Add at most 1 extra fs stat + 1 extra rename per save; target <10 ms overhead on NVMe.

### Resource / Business
- No behavior change for readers. No schema change to the envelope.

## 4. Prior Decisions

- **tmp+rename over O_TMPFILE/linkat** — Bun does not expose linkat; tmp+rename works on all 3 OS including Windows.
- **Keep 3 backups, not N** — bounded disk use; user with a corrupt vault only needs the previous generation 99% of the time. 3 gives headroom for a double-bug case.
- **Timestamped suffix over single `.bak`** — users sometimes want to step back >1 generation after a bad key rotation; single-slot overwrites that history.
- **Don't encrypt backups differently** — the envelope is already AES-GCM encrypted; `.bak` files inherit the protection.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Extract `writeAtomic(path, data)` helper in same file | tmp in same dir, mode 0o600, rename, fsync-on-write | 25 | — |
| T2 | Add `rotateBackups(path)` (keep 3 by mtime) | glob `${path}.bak-*`, sort desc, unlink tail | 15 | — |
| T3 | Wire into `saveData()`: rotate-then-atomic-write | existing callers untouched | 5 | T1, T2 |
| T4 | Regression test — simulate crash between tmp write and rename | assert original `secrets.enc` still decrypts | 40 | T3 |
| T5 | Regression test — backup rotation keeps last 3 | write 5 times, assert 3 `.bak-*` exist | 20 | T3 |

## 6. Verification

### 6.1 Unit Tests
- `tests/platform/secrets/fileFallback.test.ts`:
  - existing vault + new save → old content preserved in `secrets.enc.bak-*`
  - 5 consecutive saves → exactly 3 backups remain
  - tmp file orphan (simulate crash before rename) → `loadData` still returns prior valid envelope
  - file mode 0o600 on both tmp and final

### 6.2 E2E Tests
- Covered by SPEC-904 and SPEC-505 E2E chains (they all exercise saveData).

### 6.3 Performance Budgets
- saveData overhead <10 ms p99 on loopback filesystem.

### 6.4 Security Checks
- Mode 0o600 enforced on tmp AND final (race window check).
- `.bak-*` files also 0o600 (they inherit via rename).
- No plaintext ever hits disk — both tmp and final are the encrypted envelope.
- reviewer-security sign-off REQUIRED (touches `src/platform/secrets/`).

## 7. Interfaces

```ts
// internal helpers (not exported from module barrel)
async function writeAtomic(path: string, data: string): Promise<void>
async function rotateBackups(path: string, keep: number): Promise<void>

// existing signature unchanged — callers need no edits
async function saveData(data: VaultData): Promise<void>
```

## 8. Files Touched

- `src/platform/secrets/fileFallback.ts` (edit, ~45 LoC delta)
- `tests/platform/secrets/fileFallback.test.ts` (edit, ~60 LoC added)

## 9. Open Questions

- [ ] Should we fsync the directory entry too (POSIX durability)? Default NO — cost outweighs benefit for this workload.

## 10. Changelog

- 2026-04-17 @hiepht: draft (v0.3.9 hotfix — HARD RULE compliance, unblocks SPEC-904 + SPEC-505)
