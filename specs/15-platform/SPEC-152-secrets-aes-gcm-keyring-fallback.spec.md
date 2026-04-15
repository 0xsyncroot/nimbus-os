---
id: SPEC-152
title: Secrets — AES-GCM + OS keyring fallback
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: platform
depends_on: [META-003, META-009, SPEC-151]
blocks: [SPEC-501]
estimated_loc: 200
files_touched:
  - src/platform/secrets/index.ts
  - src/platform/secrets/keychain.ts
  - src/platform/secrets/secretService.ts
  - src/platform/secrets/credentialManager.ts
  - src/platform/secrets/fileFallback.ts
  - tests/platform/secrets/secrets.test.ts
---

# Secrets — AES-GCM + OS Keyring Fallback

## 1. Outcomes

- API keys (Anthropic, OpenAI) never touch plaintext disk: stored in Keychain (macOS) / Secret Service (Linux) / Credential Manager (Windows).
- When OS keyring unavailable (headless Linux without libsecret, locked DBus, CI), seamless fallback to AES-GCM file vault at `${nimbusHome}/secrets.enc` (0600).
- `set`/`get`/`delete`/`list` round-trip works identically across all 3 OSes — verified on CI matrix.
- Secret values never logged: audit entries redact via prefix match (`sk-ant-`, `sk-`, `ghp_`, `xai-`).

## 2. Scope

### 2.1 In-scope
- `SecretStore` interface + `getBest()` strategy selector.
- 3 OS backends (keychain/secretService/credentialManager) via `@napi-rs/keyring` with shell-out fallback (`security`, `secret-tool`).
- `fileFallback.ts`: AES-GCM encrypted JSON vault + passphrase prompt (reuse `signals.ts` for SIGINT during prompt).
- Passphrase derivation: `scrypt(N=16384, r=8, p=1)` → 32-byte key.
- Service namespacing: `nimbus-os` + per-workspace sub-namespace `nimbus-os.<wsId>`.

### 2.2 Out-of-scope
- API key rotation / expiration → v0.3.
- Multi-user (shared machine) → post-v1.0.
- Hardware security module (HSM) / YubiKey → never (non-goal for v0.1-0.5).
- Backup encryption reuses this module but lives in `storage/backup.ts` (v0.2).

## 3. Constraints

### Technical
- Bun native `crypto.subtle.{encrypt,decrypt}` for AES-GCM (no `crypto-js` dep).
- `@napi-rs/keyring` as primary; shell-out (`security add-generic-password`, `secret-tool store`) as fallback when native module not installed on target arch.
- Windows file permission: best-effort `icacls` restriction, WARN (not error) if ACL set fails.
- Zero plaintext write — always encrypt before persist.
- All errors throw `NimbusError(ErrorCode.X_CRED_ACCESS | S_STORAGE_CORRUPT | U_MISSING_CONFIG, ctx)`.
- `NIMBUS_SECRETS_BACKEND=file` env forces file fallback even when OS keyring is available (portable installs, Nix, tests). Read by `getBest()` before backend probe.

### Performance
- `get(service, account)` <50ms warm (keyring round-trip), <15ms via file fallback.
- `set(...)` <100ms (include OS prompt for first-time Keychain unlock).

### Resource
- Vault file size cap: 1MB (reject larger; indicates misuse).
- Passphrase cached in-memory per process only; never persisted; zeroed on exit via `signals.onTerminate`.

## 4. Prior Decisions

- **AES-GCM, not AES-CBC** — why: authenticated encryption (tamper detection). Reject without valid tag → throw `X_CRED_ACCESS` (cannot reliably distinguish wrong passphrase from tamper from attacker's position — both manifest as tag-verify failure). `X_AUDIT_BREAK` reserved for hash-chain audit log (SPEC-601).
- **scrypt, not PBKDF2** — why: memory-hard, slows GPU brute-force on stolen vault. Params match `crypto.scrypt` defaults.
- **Shell-out fallback next to native** — why not native-only: `@napi-rs/keyring` ships prebuilt for common arches only; musl-Alpine CI had missing binary in 2025.
- **Per-workspace namespace prefix** — why: users can have multiple workspaces with distinct Anthropic accounts; getting "API key" without ws context would collide.
- **Passphrase required on fallback** — why not random-stored-key: if key lives on disk, fallback is cosmetic. Passphrase at least forces user memory.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `SecretStore` interface + `getBest()` | selects keychain on macOS/Linux-with-DBus/Windows; else `fileFallback` | 30 | — |
| T2 | `keychain.ts` (macOS) | `set/get/delete/list` via napi-rs; shell-out `security` if native missing | 40 | T1 |
| T3 | `secretService.ts` (Linux) | detects DBus, uses libsecret; shell-out `secret-tool` fallback | 40 | T1 |
| T4 | `credentialManager.ts` (Windows) | napi-rs credential API; graceful WARN on missing arch binary | 40 | T1 |
| T5 | `fileFallback.ts` AES-GCM | scrypt passphrase → AES-GCM; rejects tag-verify failure with `X_CRED_ACCESS` (cannot distinguish wrong passphrase from tamper at crypto layer) | 100 | T1 |
| T6 | Passphrase prompt via readline | prompt hidden input; cache in-process; zero on SIGTERM | 30 | T5 |
| T7 | Round-trip tests per OS on CI | matrix green across 3 OS | 80 | T1-T6 |

## 6. Verification

### 6.1 Unit Tests
- `tests/platform/secrets/secrets.test.ts`:
  - `describe('SPEC-152: SecretStore')`:
    - Set then get: equal (round-trip).
    - Delete then get: throws `NimbusError(T_NOT_FOUND)`.
    - List: returns account names, not values.
  - `describe('SPEC-152: file fallback')`:
    - Wrong passphrase → throws `NimbusError(ErrorCode.X_CRED_ACCESS, {reason:'tag_verify_fail'})`.
    - Tampered ciphertext (flip 1 byte) → throws `NimbusError(ErrorCode.X_CRED_ACCESS, {reason:'tag_verify_fail'})` (same code; tamper vs wrong-pass indistinguishable at GCM layer by design).
    - Oversized vault (>1MB) → throws `NimbusError(ErrorCode.S_STORAGE_CORRUPT)`.
  - Redaction: `formatForAudit("sk-ant-api03-abc...")` returns `sk-ant-***`.

### 6.2 E2E Tests
- CI matrix: Set API key → restart process → Get API key → matches (on macOS/Linux/Windows runners).

### 6.3 Performance Budgets
- `get()` <50ms warm (keyring), <15ms (file fallback) via `bun:test` bench.
- `scrypt` derivation <300ms per launch (cached).

### 6.4 Security Checks
- Vault file mode 0600 enforced on Unix (asserted in test).
- Plaintext never written: fuzz test `strings secrets.enc | grep sk-` returns empty.
- Passphrase buffer zeroed after use (`buffer.fill(0)` verified via Proxy spy).
- No network call from any secrets code path (asserted via mock `fetch`).

## 7. Interfaces

```ts
// platform/secrets/index.ts
export interface SecretStore {
  readonly backend: 'keychain' | 'secret-service' | 'credential-manager' | 'file-fallback'
  set(service: string, account: string, value: string): Promise<void>
  get(service: string, account: string): Promise<string>     // throws T_NOT_FOUND if absent
  delete(service: string, account: string): Promise<void>
  list(service: string): Promise<string[]>                    // account names only, no values
}

export async function getBest(): Promise<SecretStore>         // singleton per process;
                                                               // respects NIMBUS_SECRETS_BACKEND=file override

// Zod schema for encrypted vault envelope (fileFallback.ts)
export const VaultEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kdf: z.literal('scrypt'),
  salt: z.string().regex(/^[0-9a-f]{32}$/),                   // 16 bytes hex
  iv: z.string().regex(/^[0-9a-f]{24}$/),                     // 12 bytes hex
  ciphertext: z.string(),                                      // base64
  tag: z.string().regex(/^[0-9a-f]{32}$/),                    // 16 bytes hex
})

// Audit redaction helper (exported for observability)
export function redactSecret(value: string): string           // matches sk-*, sk-ant-*, ghp_*, xai-*
```

## 8. Files Touched

- `src/platform/secrets/index.ts` (new, ~30 LoC)
- `src/platform/secrets/keychain.ts` (new, ~40 LoC)
- `src/platform/secrets/secretService.ts` (new, ~40 LoC)
- `src/platform/secrets/credentialManager.ts` (new, ~40 LoC)
- `src/platform/secrets/fileFallback.ts` (new, ~100 LoC)
- `tests/platform/secrets/secrets.test.ts` (new, ~120 LoC)

## 9. Open Questions

- [ ] Allow user to force file-fallback even when keyring available? (**Default: respect `NIMBUS_SECRETS_BACKEND=file` env**; useful for portable installs.)
- [ ] Passphrase reset flow: destroys all stored secrets — confirm UX in SPEC-901 onboarding.

## 10. Changelog

- 2026-04-15 @hiepht: draft initial v0.1.0
