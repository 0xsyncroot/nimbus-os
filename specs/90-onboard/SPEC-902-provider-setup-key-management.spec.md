---
id: SPEC-902
title: Provider setup & key management — wizard + CLI + secrets
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: onboard
depends_on: [SPEC-152, SPEC-501, SPEC-202, SPEC-203, SPEC-801, SPEC-901]
blocks: []
estimated_loc: 280
files_touched:
  - src/onboard/keyPrompt.ts
  - src/onboard/keyValidators.ts
  - src/onboard/init.ts
  - src/key/manager.ts
  - src/key/cli.ts
  - src/key/index.ts
  - src/providers/registry.ts
  - src/storage/config/schema.ts
  - src/cli.ts
  - tests/onboard/keyPrompt.test.ts
  - tests/key/manager.test.ts
  - tests/e2e/init-with-key.test.ts
---

# Provider Setup & Key Management

## 1. Outcomes

- After `nimbus init`, user chats immediately — no env-var setup, no restart
- Keys stored via SPEC-152 (OS keyring preferred, AES-GCM fallback); plaintext never on disk
- Provider+model switchable in-REPL via `/provider <id>` + `/model <class>` without restart
- Custom `baseUrl` supported (Azure OpenAI, vLLM, LiteLLM proxy, Ollama remote)
- `nimbus key {set,list,delete,test}` post-init CLI; masked input, optional live-test before store

## 2. Scope

### 2.1 In-scope (v0.1)
- Wizard key step (SPEC-901 T4b hook): masked prompt, format validate, optional live-test, store via SPEC-152
- CLI: `nimbus key set <provider>`, `nimbus key list`, `nimbus key delete <provider>`, `nimbus key test <provider>`
- Per-provider format validators (`sk-ant-`, `sk-`, `gsk_`, `sk-proj-`, DeepSeek, Ollama-none)
- Registry priority chain: CLI flag > env var > keyring/secrets > config `keyRef` > error
- Config schema extension: add `baseUrl?`, `keyRef?`, and per-provider `providers: Record<string, {baseUrl, keyRef, model}>` map
- Live test = 1 call with `max_tokens: 1`, 5s timeout, cost ≤$0.00001

### 2.2 Out-of-scope (defer)
- GUI key management → v0.4 web dashboard
- Multi-account per provider (team / personal) → v0.2
- OAuth device-code flow → v0.5
- Automated key rotation → v0.3
- Shared workspace keys → post-v1.0 (multi-user scope)

## 3. Constraints

### Technical
- Depends on SPEC-152 `secretsStore.{set,get,delete,list}()` — ALL key storage goes through that interface
- Keys namespaced per workspace: keyring service `nimbus-os.{wsId}`, account = `provider:{providerId}` (multi-workspace isolation)
- Registry resolver is pure + synchronous after one `await` load; providers call it on every request

### Security (critical — META-009 T13/T14)
- Masked input: TTY echo disabled; chars rendered as `*`
- Non-TTY interactive → `NimbusError(U_BAD_COMMAND, {reason:'non-interactive'})`; scripts use `--key-from-env VAR`
- Key NEVER logged: SENSITIVE_FIELDS extends to include keyring service/account strings; `logger.*` never receives key values
- Key NEVER in config.json: SPEC-501 `containsRawSecret` refinement rejects key-shape values in any config layer
- Format validate BEFORE store (no keyring write on reject)
- Live test 5s hard timeout; network failure ≠ invalid key (separate error codes)

## 4. Prior Decisions

- **Separate SPEC-902, not SPEC-901 bulk-add** — keys are cross-cutting (init+CLI+REPL+runtime); folding into wizard spec buries security reasoning
- **Masked readline, not env-var** — env leaks via `ps auxe`, shell history, CI dumps; masked prompt is the documented-secure default (kubectl, Claude Code)
- **Per-workspace namespace `nimbus-os.{wsId}`** — prevents `work` workspace from picking up `personal` keys; keyring account string enforces isolation
- **Config stores `keyRef`, never raw** — users sync config via dotfiles/git; `keyRef: "keyring:nimbus-os.personal/anthropic"` is safe to commit, actual key isn't
- **Live test optional** — offline-first (plane, air-gapped) must complete setup without network
- **`key test` = 1-call `max_tokens:1`** — cheapest round trip proving key+URL+not-rate-limited; <$0.00001, <2s typical, 5s hard cap
- **Priority chain CLI>env>secrets>config>error** — mirrors SPEC-501 6-layer; CLI wins one-off overrides without mutating stored state
- **`key set --base-url` always aligns workspace** — after vault store, mutate active workspace.json `defaultProvider=<key kind>` + `defaultEndpoint='custom'` (for openai-compat) + `defaultBaseUrl=<url>`. Rationale: explicit `--base-url` is unambiguous user intent — silently skipping cross-kind cases (the v0.1 first-pass safety) leaves a stale workspace pointing at the wrong provider, producing `U_MISSING_CONFIG: provider_key_missing` at REPL boot. When kind crosses (anthropic ↔ openai-compat) print `note: switching workspace default provider <old> → <new> per --base-url`. Idempotent — no message + no write when current state already matches.
- **baseUrl priority chain at resolve time** — `cliBaseUrl` > `configBaseUrl` (workspace.json) > vault `meta.baseUrl` sidecar > endpoint default. `OPENAI_BASE_URL` env feeds into `cliBaseUrl` at the REPL layer for legacy compat.

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | `keyPrompt.ts` masked readline | TTY echo off; visible chars replaced `*`; non-TTY → `U_BAD_COMMAND` | 50 | SPEC-801 |
| T2 | `keyValidators.ts` per-provider patterns + `validateKeyFormat()` | 5 providers, regex table; invalid never logged on reject | 30 | — |
| T3 | Wizard integration (key + baseUrl + model questions) | SPEC-901 T4b extension; ask only if not already stored | 40 | T1, T2, SPEC-901 |
| T4 | `key/manager.ts` — set/list/delete/test handlers | Round-trip via SPEC-152; `list` redacts all but prefix+last4 | 80 | T2, SPEC-152 |
| T5 | `providers/registry.ts` priority chain + per-request cache | Priority: CLI > env > secrets > config keyRef > throw `P_AUTH` | 40 | T4 |
| T6 | `storage/config/schema.ts` extend | Add `baseUrl?`, `keyRef?`, `providers` map; containsRawSecret still passes | 20 | SPEC-501 |
| T7 | `cli.ts` route `nimbus key ...` + `--key-from-env` flag | Exit codes 0/2/3 mirror rest of CLI | 20 | T4 |

## 6. Verification

### 6.1 Unit Tests
- `keyPrompt.test.ts`: masked input replaces chars with `*`; non-TTY → `U_BAD_COMMAND`; Ctrl-C rejects cleanly
- `keyValidators.test.ts`: each provider's valid fixture accepted; invalid shapes → `T_VALIDATION`; reject path never logs raw value (spy-verified)
- `manager.test.ts`: `set→list→delete→list` round-trip; list redacted to prefix+last4; `test` distinguishes ok / `P_NETWORK` / `P_AUTH`; 5s timeout honored

### 6.2 E2E Tests
- `init-with-key.test.ts`: piped init answers incl. provider+key → workspace created → REPL starts → first turn succeeds
- `key-cli.test.ts`: `set openai → list (redacted) → test openai → delete openai → list empty`
- `provider-switch.test.ts`: REPL `/provider openai` then `/model budget` → next turn uses gpt-4o-mini without restart

### 6.3 Security + Performance
- `grep -r 'sk-ant\|sk-proj\|gsk_' ~/.nimbus/logs/` after init → **no matches** (test assertion)
- `key list` regex-asserted to never show >4 chars after prefix
- Config `{apiKey:'sk-ant-real'}` → SPEC-501 `containsRawSecret` rejects with `S_CONFIG_INVALID` + JSON pointer
- `key test` p95 <2s, hard 5s; cost <$0.00001/call

## 7. Interfaces

```ts
// keyPrompt.ts
export interface KeyPromptOptions { provider: string; maskChar?: string; allowEmpty?: boolean }
export function promptApiKey(opts: KeyPromptOptions): Promise<string>

// keyValidators.ts
export const KEY_FORMAT_PATTERNS: Record<string, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
  openai:    /^sk-(proj-)?[A-Za-z0-9_\-]{20,}$/,
  groq:      /^gsk_[A-Za-z0-9]{20,}$/,
  deepseek:  /^sk-[A-Za-z0-9]{20,}$/,
  ollama:    /^.*$/,
}
export function validateKeyFormat(provider: string, key: string): void  // throws T_VALIDATION

// key/manager.ts
export interface KeyTestResult { ok: boolean; latencyMs: number; costUsd: number; errorCode?: string }
export interface KeyManager {
  set(provider: string, key: string, opts?: { baseUrl?: string; liveTest?: boolean }): Promise<void>
  list(): Promise<Array<{ provider: string; masked: string; createdAt: number }>>
  delete(provider: string): Promise<void>
  test(provider: string): Promise<KeyTestResult>
}

// providers/registry.ts — priority chain CLI>env>secrets>config>throw(P_AUTH)
export interface ResolvedKey { provider: string; apiKey: string; baseUrl?: string; source: 'cli'|'env'|'secrets'|'config' }
export interface ProviderResolver { resolve(provider: string, cliFlags: Record<string, unknown>): Promise<ResolvedKey> }

// storage/config/schema.ts — SPEC-501 delta
const ProviderEntrySchema = z.object({
  baseUrl: z.string().url().optional(),
  keyRef: z.string().regex(/^keyring:/).optional(),
  model: z.string().optional(),
})
// NimbusConfigSchema: providers: z.record(z.string(), ProviderEntrySchema).default({})
```

## 8. Files Touched

- `src/onboard/keyPrompt.ts` (~50), `src/onboard/keyValidators.ts` (~30)
- `src/key/manager.ts` (~80)
- `src/providers/registry.ts` (~40 delta), `src/storage/config/schema.ts` (~20 delta), `src/cli.ts` (~20 delta)
- `tests/onboard/keyPrompt.test.ts` (~100), `tests/key/manager.test.ts` (~180), `tests/e2e/init-with-key.test.ts` (~120)

## 9. Open Questions

- [ ] `key set` auto-run `key test` by default? (lean yes, `--no-test` opt-out)
- [ ] Key age warning in REPL banner at >90d — v0.3 polish
- [ ] Workspace-A key, run workspace-B — fall back to user-global or refuse? (lean: fall back + banner)

## 10. Changelog

- 2026-04-15 @hiepht: draft — extracted from SPEC-901; T13/T14; per-ws namespace
- 2026-04-15 @hiepht: implemented. baseUrl priority chain at REPL boot: workspace.json defaultBaseUrl > secret-store meta.baseUrl > OPENAI_BASE_URL env > endpoint default. Validator relaxed for openai-compat custom endpoints (baseUrl hostname ≠ api.openai.com skips sk- regex; control-char/length checks still apply). `key set --base-url` auto-aligns workspace.json when active workspace's kind matches.
