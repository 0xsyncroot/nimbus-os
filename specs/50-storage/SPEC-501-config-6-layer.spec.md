---
id: SPEC-501
title: Config 6-layer merge + profiles
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: storage
depends_on: [META-003, SPEC-151, SPEC-401, SPEC-402]
blocks: [SPEC-101, SPEC-106, SPEC-801]
estimated_loc: 200
files_touched:
  - src/storage/config/schema.ts
  - src/storage/config/loader.ts
  - src/storage/config/profiles.ts
  - src/storage/config/merge.ts
  - tests/storage/config.test.ts
---

# Config 6-Layer + Profiles

## 1. Outcomes

- Single `loadConfig()` returns merged effective config from 6 sources in defined precedence
- User edits `~/.nimbus/config.json` reflect next REPL start; CLI flags override in-memory immediately
- Profile `personal` / `work` switch defaults for model/provider/budget via `--profile X` or `NIMBUS_PROFILE=X`
- Corrupt config → `S_CONFIG_INVALID` with JSON pointer to offending field; nimbus refuses start (fail-closed)

## 2. Scope

### 2.1 In-scope
- Zod `NimbusConfig` schema (model, provider, permissions, logging, cost placeholders)
- Loaders for 6 layers: CLI flags → env vars → workspace `./nimbus.config.json` → profile → user `~/.nimbus/config.json` → built-in defaults
- Deep merge with array replace (not concat) semantics
- Profiles manager: list, create, delete, switch active
- JSON Pointer error paths in validation failures

### 2.2 Out-of-scope
- Secrets storage → SPEC-152 (config NEVER holds tokens; refs only)
- Schema migrations → v0.2 (schemaVersion field reserved)
- Live reload on file change → v0.3

## 3. Constraints

### Technical
- Bun `Bun.file().json()` for reads; atomic writes via temp + rename
- File mode `0600` on user config (contains preferences but we harden anyway)
- All I/O through `SPEC-151` platform.paths

### Performance
- `loadConfig()` cold <30ms (6 small JSON reads)
- Merge 6 layers <1ms

## 4. Prior Decisions

- **6 layers explicit** — mimics Claude Code familiarity; each layer has one clear job
- **Array replace, not concat** — "workspace-only set" should fully override user rules list, else merging gets unpredictable. Limitation: loses user baseline silently; future `$replace`/`$append` sentinel keys planned v0.2 for explicit intent
- **Profiles live in user dir not workspace** — profiles are personal preference sets, orthogonal to workspace
- **Fail-closed on corrupt** — running with half-parsed config is worse than refusing boot

## 5. Task Breakdown

| ID | Task | Acceptance | Est LoC | Depends |
|----|------|------------|---------|---------|
| T1 | Zod `NimbusConfig` schema | 100% field coverage + test fixtures | 50 | — |
| T2 | 6 layer loaders | Each returns `Partial<NimbusConfig>`; missing → `{}` | 60 | T1 |
| T3 | Deep merge (array replace) | Fixture table test for precedence ordering | 30 | T2 |
| T4 | Profile manager | list/create/delete/switch; writes `~/.nimbus/profiles/{name}.json` | 40 | T2 |
| T5 | `loadConfig()` public API | Integration test: override chain CLI > env > ... | 20 | T3, T4 |

## 6. Verification

### 6.1 Unit Tests
- Schema: valid fixtures pass; missing required → `S_CONFIG_INVALID` with JSON pointer `/provider/model`
- Merge: CLI `--model X` beats env `NIMBUS_MODEL=Y` beats workspace config Z
- Profile switch: `NIMBUS_PROFILE=work` picks `work.json` model
- Array replace: user rules `[A, B]` + workspace rules `[C]` → effective `[C]` (not `[A,B,C]`)

### 6.2 E2E Tests
- `tests/e2e/config-precedence.test.ts`: all 6 layers set conflicting value → CLI wins
- Corrupt user config → nimbus exits 2 with pointer error

### 6.3 Performance Budgets
- `loadConfig()` warm <10ms (cached mtime)

### 6.4 Security Checks
- Config values containing `${ENV}` NOT interpolated (no shell-like expansion)
- Path fields validated (no traversal to `/etc`)
- Secrets fields rejected at schema level (`apiKey` must be `{ref: 'keyring:anthropic'}` not raw)

## 7. Interfaces

```ts
export const NimbusConfigSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.object({
    default: z.enum(['anthropic', 'openai', 'groq', 'deepseek', 'ollama']),
    model: z.string(),
  }),
  permissions: z.object({
    mode: PermissionModeSchema.default('default'),
    rules: z.array(RuleStringSchema).default([]),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    retention: z.object({ metricsDays: z.number().default(30) }),
  }),
  cost: z.object({
    trackEnabled: z.boolean().default(true),
  }),
  profile: z.string().optional(),
})
.refine(c => !containsRawSecret(JSON.stringify(c)), {
  message: 'raw secret-shaped value detected — use {ref:"keyring:..."} instead',
  path: ['<scan>'],
})

// Secret reference schema — config holds refs only, never raw tokens
export const SecretRefSchema = z.object({
  ref: z.string().regex(/^keyring:[a-z][a-z0-9-]+$/),   // e.g. 'keyring:anthropic'
})
export type SecretRef = z.infer<typeof SecretRefSchema>

// containsRawSecret scans stringified config for `sk-*`, `ghp_*`, `xoxb-*`, bearer-shaped values
declare function containsRawSecret(s: string): boolean
export type NimbusConfig = z.infer<typeof NimbusConfigSchema>

export type ConfigLayer = 'cli' | 'env' | 'workspace' | 'profile' | 'user' | 'default'

export interface ConfigLoader {
  loadConfig(cliFlags: Record<string, unknown>, workspaceRoot?: string): Promise<NimbusConfig>
  listProfiles(): Promise<string[]>
  createProfile(name: string, base?: Partial<NimbusConfig>): Promise<void>
  deleteProfile(name: string): Promise<void>
  switchProfile(name: string): Promise<void>
}

export interface ConfigMergeTrace {
  field: string                 // JSON pointer
  value: unknown
  source: ConfigLayer
}
```

## 8. Files Touched

- `src/storage/config/schema.ts` (~60 LoC)
- `src/storage/config/loader.ts` (~80 LoC)
- `src/storage/config/profiles.ts` (~40 LoC)
- `src/storage/config/merge.ts` (~30 LoC)
- `tests/storage/config.test.ts` (~180 LoC)

## 9. Open Questions

- [ ] Surface merge trace in `nimbus config show --trace` — v0.2?
- [ ] Encrypted user config option (passphrase) — v0.3 defer

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: revise per reviewer — depends_on adds SPEC-401/402 (schema imports); `SecretRefSchema` + `containsRawSecret` refinement; `deleteProfile` in ConfigLoader; array-replace limitation noted
