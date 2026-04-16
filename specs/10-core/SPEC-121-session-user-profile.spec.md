---
id: SPEC-121
title: Session user profile — identity metadata per session
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3
layer: core
depends_on: [SPEC-101, SPEC-102]
blocks: [SPEC-122]
estimated_loc: 80
files_touched:
  - src/core/sessionManager.ts
  - tests/core/sessionUserProfile.test.ts
---

# Session user profile — identity metadata per session

## 1. Outcomes

- Each session record in JSONL (SPEC-102) carries an optional `userProfile` field: `{channelUserId, channelAdapterId, displayName}`.
- `sessionManager.ts` exposes `setUserProfile(sessionId, profile)` and `getUserProfile(sessionId)`.
- Session preferences (SPEC-122) depend on this to identify the session owner across channels.

## 2. Scope

### 2.1 In-scope
- Zod schema `UserProfileSchema` with `channelUserId: string`, `channelAdapterId: string`, `displayName?: string`
- `setUserProfile` writes `userProfile` field to session JSONL meta entry (non-destructive update)
- `getUserProfile` reads from in-memory session state; falls back to JSONL scan if session evicted
- Channel adapters (SPEC-803/804/805) call `setUserProfile` on first message from a user

### 2.2 Out-of-scope
- Cross-channel user identity deduplication → v0.4
- Avatar / contact-level profile enrichment → v0.4
- GDPR deletion flow → v0.5

## 3. Constraints

### Technical
- No `any` types; strict TypeScript
- `UserProfile` stored inline in session JSONL entry — no separate table
- `displayName` max 128 chars; `channelUserId` max 256 chars

### Performance
- `getUserProfile` <2ms warm (in-memory lookup)

### Resource / Business
- 1 dev, <1 day

## 4. Prior Decisions

- **Inline in session JSONL** — avoids a separate profile store; session lifetime bounds the data; consistent with SPEC-102 JSONL approach
- **Optional `displayName`** — channel adapters may not have display names (e.g., HTTP bearer token user has no display name); nullable is correct

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Zod schema + types | Schema rejects missing `channelUserId`; accepts missing `displayName` | 20 | — |
| T2 | `setUserProfile` + `getUserProfile` in sessionManager | Unit: set then get returns same object; missing session throws `NimbusError` | 60 | T1 |

## 6. Verification

### 6.1 Unit Tests
- `sessionUserProfile.test.ts`:
  - Set profile → get returns matching object
  - Missing `channelUserId` → Zod throws
  - Unknown `sessionId` → `NimbusError(ErrorCode.T_NOT_FOUND)`

### 6.2 E2E Tests
- Covered by SPEC-122 e2e (profile set by adapter, prefs read in same session)

### 6.3 Performance Budgets
- `getUserProfile` <2ms warm via bench

### 6.4 Security Checks
- `displayName` sanitised (HTML-stripped) before storing — prevents injection via Telegram/Slack display names

## 7. Interfaces

```ts
export const UserProfileSchema = z.object({
  channelUserId: z.string().min(1).max(256),
  channelAdapterId: z.string().min(1).max(64),
  displayName: z.string().max(128).optional(),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

export function setUserProfile(sessionId: string, profile: UserProfile): Promise<void>
export function getUserProfile(sessionId: string): Promise<UserProfile | null>
```

## 8. Files Touched

- `src/core/sessionManager.ts` (modify, +30 LoC)
- `tests/core/sessionUserProfile.test.ts` (new, ~50 LoC)

## 9. Open Questions

- [ ] Should profile be immutable after first set, or updatable mid-session? (lean: updatable for display name changes)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — scaffolded as SPEC-122 dependency
