---
id: SPEC-310
title: Skills registry with trust tiers and risk assessment
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: tools
depends_on: [SPEC-401, SPEC-152, META-003, META-009]
blocks: []
estimated_loc: 800
files_touched:
  - src/skills/manifest.ts
  - src/skills/registryClient.ts
  - src/skills/analyzer.ts
  - src/skills/sandbox.ts
  - src/skills/installer.ts
  - src/skills/revocation.ts
  - tests/skills/analyzer.test.ts
  - tests/skills/sandbox.test.ts
  - tests/skills/installer.test.ts
---

# Skills registry — trusted/community/local tiers with risk assessment

## 1. Outcomes

- Agent installs community skills from public registry after user views risk report and confirms
- Trusted/vetted skills auto-install if automated eval passes — no user confirm needed
- Every skill (including trusted) runs in mandatory Bun Worker sandbox
- Permission-delta on upgrade triggers re-prompt; silent widening is blocked
- Malicious skill revocation reaches users within one session of disclosure

## 2. Scope

### 2.1 In-scope

- **3-tier model**: TRUSTED (maintainer-signed, auto-install if eval passes), COMMUNITY (risk report + user confirm), LOCAL (user dev, no eval gate)
- **Registry**: Git-backed index (`github.com/nimbus-os/skills-registry`) + OCI artifact bundles; mirrors via `~/.nimbus/registries.json` (ADR-S01)
- **Manifest schema**: `SkillManifest` with identity, permissions (bash/fsRead/fsWrite/network/env/sideEffects), tools, deps, trust metadata
- **Bundle format**: OCI multi-layer artifact + cosign detached signature (ADR-S02)
- **Signing**: sigstore keyless (OIDC-bound short-lived certs) + ed25519 registry-root pinned in nimbus binary
- **9 static-analysis risk dimensions**: subprocess spawn, bash commands, fs write scope, network egress, secrets access, dynamic code (eval/new Function), permission delta, dep CVE audit (osv-scanner), obfuscation (entropy >4.5)
- **Sandbox**: mandatory Bun Worker with manifest-derived permission flags (`--deny-all` baseline + `--allow-net=<host>` etc.) — even for TRUSTED tier. Runtime enforcement test: sandbox blocks bash/network outside declared manifest perms (not just flagged at analysis time).
- **Risk report UX**: tier badge + plain-English; LOW→[y/N]; MED→[y/N]+3s delay; HIGH→typed-phrase confirm (type skill name, not "yes"); `--yes` ignored for MED/HIGH
- **Trusted auto-install notification**: one-line non-blocking banner on auto-install (e.g., `[SKILL] auto-installed gh-triage v1.4.2 (trusted)`). Prevents silent deployment from compromised maintainer key.
- **LOCAL tier sandbox**: LOCAL skills still respect sandbox network restrictions from manifest (user code doesn't get free network egress)
- **Commands**: `nimbus skill search|install|list|info|upgrade|revoke|reassess|audit|undo`
- **Upgrade**: diff-based — silent if perms identical, full re-prompt on any permission widening
- **Version resolution**: exact-version-only for v0.3 (SAT solver deferred to v0.4 per cost review — de-risk timeline), per-workspace `skills.lock`
- **Multi-workspace**: global content-addressed install, per-workspace activation with narrow-only permission overrides (never widen)
- **Offline**: index 6h stale-while-revalidate, bundles immutable cache forever, revocation feed hard-fail install if >7d stale
- **Revocation**: signed `revocations.json` polled on launch + 6h daemon tick → auto-quarantine to `~/.nimbus/skills/quarantine/`; non-dismissable banner until user resolves

### 2.2 Out-of-scope

- Registry hosting infra (use github.com initially)
- Web UI for registry browse (CLI only v0.3)
- Paid skills / marketplace (future)
- Cross-skill prompt composition (v0.5)

## 3. Constraints

### Technical
- PolyForm NC compat; Bun Worker sandbox (not vm2/subprocess)
- Sigstore verification offline-capable via cached Rekor checkpoint
- No same-process skill execution even for TRUSTED
- TypeScript strict, max 400 LoC per file, no `any`

### Security
- Rate limit: >3 community installs/hour triggers 60s cool-off
- Typosquatting defense: Levenshtein ≤2 from existing names → block at publish; unicode confusable normalization
- Prompt injection defense: skill tool output wrapped in `<tool_output trusted="false">` boundary per META-009

### Performance
- Risk analysis <5s per skill (static analysis, no execution)
- Registry index search <200ms (local JSON)

## 4. Prior Decisions

- **ADR-S01** Git-backed index + OCI bundles — reject npm-HTTP (hosting cost, SPF), S3-only (no search)
- **ADR-S02** OCI multi-layer + cosign — reject tar.gz (no content-addressing), zip (no integrity)
- **ADR-S03** Single-version cargo-style + SAT solver — reject npm nested trees (duplicate-tool-name conflicts break permission audits)
- **ADR-S04** Global install + per-workspace activation + narrow-only overrides — reject per-workspace install (wastes disk, version drift)
- **ADR-S05** Tier separation on disk + promotion via maintainer-signed PR + quarantine-not-delete — reject auto-uninstall (preserves audit trail)
- **ADR-S06** Offline: 6h SWR index, immutable bundles, revocation hard-fail 7d stale
- **ADR-S07** SkillManifest sideEffects aligned to SPEC-103 four-category enum
- **Sigstore over ed25519-direct** — OIDC-bound short-lived certs, Rekor transparency log, industry alignment (npm provenance, PyPI trusted publishing)
- **Mandatory Bun Worker sandbox** — static analysis necessary-not-sufficient against obfuscation and runtime payload; defense-in-depth with ~5ms overhead
- **Typed-phrase confirm for HIGH** — prevents muscle-memory rubber-stamping (user types skill name, not generic "yes")
- **Community skills escalated v0.5→v0.3** — user validated as priority; agent needs external skills for general-purpose OS vision. Plan formally amended (architect review flagged v0.5→v0.3 is scope escalation — user decision overrides plan)
- **SAT solver deferred v0.3→v0.4** — exact-version-only for v0.3 (cost reviewer: SAT in 80 LoC is notoriously tricky, de-risk)
- **OCI hosting**: GitHub Container Registry free tier sufficient for v0.3 (~50 skills). At 500+ skills, self-hosted or ghcr.io paid tier needed (~$5/mo). Cost estimate added per cost review.
- **Worker cold-start budgeted**: Bun Worker with permission flags cold-starts at ~50-100ms (not 5ms as originally claimed). Verification bench added.
- **Sigstore verify on launch budgeted**: <500ms; cache verification result 1h TTL. Revocation feed poll async (non-blocking CLI startup).

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Manifest schema + Zod | validate + reject malformed fixtures | 60 | — |
| T2 | Registry client (git clone + index parse + OCI fetch) | fetch + store + offline-cache | 100 | T1 |
| T3 | Sigstore verification | verify signed + reject unsigned + offline Rekor cache | 80 | T2 |
| T4 | Static analyzer 9 dims | per-dim fixture pass/fail, gate logic (refuse/High/Med/Low) | 150 | T1 |
| T5 | Bun Worker sandbox runner | manifest perms → Worker flags, skill runs isolated | 120 | T1 |
| T6 | Risk report renderer | LOW/MED/HIGH format, typed-phrase HIGH confirm | 60 | T4 |
| T7 | Install/upgrade/revoke commands | full CLI flow, perm-delta re-prompt on upgrade | 80 | T2,T3,T4,T5,T6 |
| T8 | Exact-version resolution (SAT deferred v0.4) | resolve pinned versions, conflict → trace | 30 | T1 |
| T9 | Per-workspace activation + narrow-only perms | skills.json + override validation | 60 | T7 |
| T10 | Revocation feed poller + quarantine | signed feed, auto-quarantine, non-dismissable banner | 40 | T2 |
| T11 | Audit log + undo | append-only JSONL, undo reverts last install within 24h | 30 | T7 |
| T12 | Tests | all dims + flows covered | 300 | all |

## 6. Verification

### 6.1 Unit Tests
- Manifest schema (accept/reject), sigstore signing/verify, 9 risk-dim detection fixtures, SAT solver, perm-narrowing, audit log append

### 6.2 E2E Tests
- Full install → sandbox run → revoke flow
- Typosquatting detection (Levenshtein block)
- Permission-delta re-prompt on upgrade
- Offline install with cached bundle → success; stale revocation >7d → refuse

### 6.3 Security Checks
- Revocation hard-fail on 7d stale
- Worker sandbox escape attempt → blocked
- Sigstore invalid-sig → rejected
- `eval`/`new Function` in skill code → HIGH risk flagged
- Skill output → wrapped as untrusted data in Canonical IR

## 7. Interfaces

```ts
interface SkillManifest {
  name: string;                      // scoped: "@user/skill-name"
  version: string;                   // semver
  description: string;               // ≤140 chars
  author: { name: string; email?: string };
  license: string;                   // SPDX
  minNimbusVersion: string;          // semver range
  entry: { prompts?: string[]; code?: string; tools?: string[] };
  permissions: {
    bash?: { allow: string[]; deny?: string[] };
    fsRead?: string[];
    fsWrite?: string[];
    network?: { hosts: string[] };
    env?: string[];
    sideEffects: 'pure' | 'read' | 'write' | 'exec';
  };
  trust: {
    tier: 'trusted' | 'community' | 'local';
    signedBy?: string;
    bundleDigest: string;            // sha256
  };
}

type RiskLevel = 'low' | 'medium' | 'high' | 'refuse';
interface RiskReport {
  skill: string; version: string; tier: string;
  score: number;                     // 0-100
  level: RiskLevel;
  permissions: SkillManifest['permissions'];
  risks: Array<{ dim: string; severity: RiskLevel; detail: string }>;
}
```

## 8. Files Touched

- `src/skills/registry/manifest.ts` (new, ~60 LoC)
- `src/skills/registry/client.ts` (new, ~100 LoC)
- `src/skills/registry/analyzer.ts` (new, ~150 LoC)
- `src/skills/registry/sandbox.ts` (new, ~120 LoC)
- `src/skills/registry/installer.ts` (new, ~80 LoC)
- `src/skills/registry/revocation.ts` (new, ~40 LoC)
- `tests/skills/registry/*.test.ts` (new, ~300 LoC)

## 9. Open Questions

- [ ] Who curates the trusted allowlist initially? (maintainer only v0.3, committee v0.4?)
- [ ] Should `nimbus skill search` include a quality/popularity score? (defer v0.4)

## 10. Changelog

- 2026-04-16 @hiepht: draft — synthesized from 3 analyst reports (security, UX, architecture)
