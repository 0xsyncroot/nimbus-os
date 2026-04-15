---
id: META-003
title: Error taxonomy — ErrorCode enum + NimbusError contract
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
layer: meta
depends_on: []
---

# Error Taxonomy

## 1. Purpose

Define a central `ErrorCode` enum that every throw site in nimbus-os maps to. Enables:
- Deterministic self-heal policy (code → strategy)
- Aggregation in observability (group by code, not string)
- Grep-friendly debugging (stable identifiers)
- 100% test coverage enforcement

## 2. Contract

### 2.1 ErrorCode enum (6 families)

```ts
export enum ErrorCode {
  // Provider (P*) — transient + auth + API
  P_NETWORK          = 'P_NETWORK',           // DNS/TCP/TLS/timeout
  P_5XX              = 'P_5XX',
  P_429              = 'P_429',
  P_AUTH             = 'P_AUTH',              // 401/403 — user must fix
  P_INVALID_REQUEST  = 'P_INVALID_REQUEST',   // 400 — our bug
  P_CONTEXT_OVERFLOW = 'P_CONTEXT_OVERFLOW',  // window exceeded
  P_MODEL_NOT_FOUND  = 'P_MODEL_NOT_FOUND',

  // Tool (T*)
  T_TIMEOUT          = 'T_TIMEOUT',
  T_CRASH            = 'T_CRASH',             // unexpected exception
  T_VALIDATION       = 'T_VALIDATION',        // Zod input fail
  T_PERMISSION       = 'T_PERMISSION',        // gate denied
  T_NOT_FOUND        = 'T_NOT_FOUND',
  T_MCP_UNAVAILABLE  = 'T_MCP_UNAVAILABLE',
  T_ITERATION_CAP    = 'T_ITERATION_CAP',     // agent loop hit max iterations

  // Session/Storage (S*)
  S_COMPACT_FAIL     = 'S_COMPACT_FAIL',
  S_STORAGE_CORRUPT  = 'S_STORAGE_CORRUPT',
  S_CONFIG_INVALID   = 'S_CONFIG_INVALID',
  S_SOUL_PARSE       = 'S_SOUL_PARSE',
  S_MEMORY_CONFLICT  = 'S_MEMORY_CONFLICT',
  S_SCHEMA_MISMATCH  = 'S_SCHEMA_MISMATCH',

  // Security (X*) — NEVER auto-heal, always escalate
  X_BASH_BLOCKED     = 'X_BASH_BLOCKED',
  X_PATH_BLOCKED     = 'X_PATH_BLOCKED',
  X_NETWORK_BLOCKED  = 'X_NETWORK_BLOCKED',
  X_INJECTION        = 'X_INJECTION',         // prompt injection detected
  X_CRED_ACCESS      = 'X_CRED_ACCESS',       // attempted access to .ssh/.env/etc
  X_AUDIT_BREAK      = 'X_AUDIT_BREAK',       // audit chain tampered

  // User (U*)
  U_BAD_COMMAND      = 'U_BAD_COMMAND',
  U_MISSING_CONFIG   = 'U_MISSING_CONFIG',

  // System (Y*)
  Y_OOM                  = 'Y_OOM',
  Y_DISK_FULL            = 'Y_DISK_FULL',
  Y_SUBAGENT_CRASH       = 'Y_SUBAGENT_CRASH',
  Y_DAEMON_CRASH         = 'Y_DAEMON_CRASH',
  Y_CIRCUIT_BREAKER_OPEN = 'Y_CIRCUIT_BREAKER_OPEN', // 3 consecutive errors → pause
}
```

### 2.2 NimbusError class

```ts
export class NimbusError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly context: Record<string, unknown> = {},
    public override readonly cause?: Error,
  ) {
    super(`${code}: ${JSON.stringify(context)}`)
    this.name = 'NimbusError'
  }
  
  get retryable(): boolean { return isRetryable(this.code) }
  get userFacing(): boolean { return isUserFacing(this.code) }
}

export function classify(err: unknown): ErrorCode { /* ... */ }
```

**Throw rule**: EVERY throw site MUST `throw new NimbusError(ErrorCode.X_YYY, ctx)`. NEVER `throw new Error('string')` or `throw 'string'`. Enforced via lint rule.

### 2.3 Self-heal strategy mapping

See plan section 6.5 "Self-Healing Policy Matrix". Summary:
- P_NETWORK/P_5XX → retry exp backoff (3)
- P_429 → respect retry-after + model switch
- P_AUTH → escalate-user
- T_CRASH → retry 1×, feed-to-llm
- T_PERMISSION → escalate-user (cache decision per-session)
- **X_*** → **ALWAYS escalate-user, NEVER auto-recover**
- Y_DAEMON_CRASH → supervisor restart + mark in-progress turn aborted

## 3. Rationale

- **Stable strings not integers**: grep-friendly (`grep X_BASH logs`)
- **Prefix families**: immediate severity category (X_ = security, always alert)
- **NimbusError wraps cause**: preserve stack trace + machine-readable code
- **classify() at system boundary**: catches raw Error from fetch/fs/child_process, normalizes into ErrorCode

## 4. Consumers

- SPEC-601 (observability) — aggregate metrics by code
- selfHeal/policies.ts — dispatch table keyed by code
- Every module throwing errors (permissions, tools, providers, storage, ...)

## 5. Evolution Policy

Adding a code: bump enum + add self-heal policy + add tests. No breaking change.
Removing a code: deprecate via comment, keep enum value stable forever, migrate references.

**Context vs new code**: prefer adding `{reason: 'specific'}` to NimbusError context BEFORE proposing new ErrorCode. New code only when:
- Distinct self-heal policy needed (different retry behavior)
- Distinct user-facing message needed
- Distinct dashboard aggregation needed (separate metric)

Example: `T_TIMEOUT` covers both API and tool timeouts; differentiate via `ctx.source = 'api'|'tool'`. But `T_ITERATION_CAP` got own code because it has unique policy (escalate-user, no retry — different from `T_TIMEOUT` retry).

## 6. Changelog

- 2026-04-15 @hiepht: initial + approve
