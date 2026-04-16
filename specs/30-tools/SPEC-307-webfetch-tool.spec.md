---
id: SPEC-307
title: WebFetch tool — GET URL to markdown/text
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
implemented: 2026-04-16
release: v0.2
layer: tools
depends_on: [SPEC-301, META-009]
blocks: []
estimated_loc: 150
files_touched:
  - src/tools/builtin/WebFetch.ts
  - tests/tools/builtin/webFetch.test.ts
---

# WebFetch tool — GET URL to markdown/text

## 1. Outcomes

- Agent fetches a single HTTPS URL and receives readable content as markdown, plain text, or raw HTML
- SSRF guard blocks private IPs and cloud metadata endpoints, preventing server-side request forgery
- Per-workspace URL cache (TTL 5 min) prevents redundant fetches within a session
- Output capped at 50K chars so LLM context budget is not blown by a single fetch

## 2. Scope

### 2.1 In-scope

- Zod input `{url: string, mode?: 'markdown'|'text'|'raw', timeout?: number}`
- GET only; HTTPS required; byte cap 1 MB; timeout default 15s
- `ssrfGuard` validation: block private IP ranges (RFC 1918 + loopback), link-local, and cloud metadata (169.254.169.254)
- Strip `<script>` and `<style>` tags before passing to Readability
- `@mozilla/readability` for article extraction + `turndown` for HTML→markdown conversion
- Output modes: `markdown` (default via Readability+Turndown), `text` (tag-stripped plain), `raw` (original HTML)
- Output capped at 50K chars; excess truncated with notice appended
- Tool output wrapped `trusted="false"` per META-009 T2
- Cache: on-disk JSON per workspace, key = sha256(url), TTL 5 min, max 200 entries

### 2.2 Out-of-scope

- POST/PUT/PATCH requests — fetch is read-only; form submission is out of scope
- JavaScript rendering (requires browser engine) → SPEC-403
- Cookie/session auth → deferred v0.3
- WebSearch (finding URLs) → SPEC-305

## 3. Constraints

### Technical

- Bun-native fetch, TypeScript strict, max 400 LoC per file, no `any`
- HTTPS-only URLs enforced; reject `http://` and non-URL inputs
- Readability + turndown imported as npm deps (already in tech stack per CLAUDE.md)

### Performance

- Fetch + parse <3s p95 for 500KB page (network-bound)
- Cache lookup <5ms

### Resource / Business

- 1 dev part-time
- Zero extra cloud dependency (runs with local fetch)

## 4. Prior Decisions

- **Readability + Turndown over custom parser** — battle-tested extraction used by Firefox; avoids maintaining fragile regex scraper
- **HTTPS-only** — HTTP fetches expose user traffic; SSRF risk doubles on plain HTTP due to no TLS cert check
- **ssrfGuard reuse from SPEC-305** — same guard already covers WebSearch; don't duplicate DNS-rebind logic
- **50K char cap** — GPT-4o context is 128K; 50K leaves room for the rest of the conversation
- **Cache TTL 5 min** — short enough to pick up hot-breaking-news updates; long enough to avoid hammering the same page per turn

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Zod input/output schema + types | Schema round-trips; rejects non-HTTPS, invalid URL | 20 | — |
| T2 | Fetch + Readability + Turndown pipeline | 200/timeout/1MB-cap mocks pass; markdown output matches fixture | 50 | T1 |
| T3 | ssrfGuard integration | Private-IP and metadata-URL inputs throw `NimbusError` | 20 | T1 |
| T4 | Cache layer (file-backed, TTL 5 min) | Hit/miss/expire tests; max-entry eviction test | 20 | T2 |
| T5 | Output cap + script/style strip | 51K input truncated; `<script>` absent in all modes | 15 | T2 |
| T6 | Unit tests | ≥90% line coverage on WebFetch.ts | 80 | T1-T5 |

## 6. Verification

### 6.1 Unit Tests

- `tests/tools/builtin/webFetch.test.ts`: HTTP mock for 200/timeout/1MB-cap/non-HTTPS/private-IP
- Mode fixture: same URL → markdown contains no `<` tags; text is plain; raw preserved
- Cache TTL: second call within 5 min returns cached; after expire, re-fetches
- Output cap: 60K char body → result length ≤ 50K + truncation notice

### 6.2 E2E Tests

- Stub HTTP server returns article HTML → agent receives markdown summary

### 6.3 Performance Budgets

- Warm cache lookup <5ms via `bun:test` bench

### 6.4 Security Checks

- `http://example.com` → rejected (non-HTTPS)
- `http://169.254.169.254/latest/meta-data/` → `NimbusError` (cloud metadata blocked)
- `http://192.168.1.1` → `NimbusError` (private IP blocked)
- `<script>alert(1)</script>` in page body → absent from all output modes

## 7. Interfaces

```ts
const WebFetchInputSchema = z.object({
  url: z.string().url(),
  mode: z.enum(['markdown', 'text', 'raw']).optional().default('markdown'),
  timeout: z.number().int().min(1000).max(30000).optional().default(15000),
});
export type WebFetchInput = z.infer<typeof WebFetchInputSchema>

const WebFetchOutputSchema = z.object({
  url: z.string(),
  mode: z.enum(['markdown', 'text', 'raw']),
  content: z.string(),
  truncated: z.boolean(),
  cached: z.boolean(),
  title: z.string().optional(),
});
export type WebFetchOutput = z.infer<typeof WebFetchOutputSchema>

export interface WebFetchTool {
  execute(input: WebFetchInput, workspaceId: string): Promise<WebFetchOutput>
}
```

## 8. Files Touched

- `src/tools/builtin/WebFetch.ts` (new, ~150 LoC)
- `tests/tools/builtin/webFetch.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should `raw` mode also strip scripts for safety, or honour truly-raw semantics? (v0.2 decision)
- [ ] Respect `robots.txt`? (legal/ethical — defer v0.3)

## 10. Changelog

- 2026-04-16 @hiepht: draft initial — WebFetch complement to SPEC-305 WebSearch
