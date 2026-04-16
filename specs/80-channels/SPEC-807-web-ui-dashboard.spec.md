---
id: SPEC-807
title: Local Web UI dashboard — vanilla HTML mounted on Bun.serve
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.3.1
layer: channels
depends_on: [SPEC-805, SPEC-806]
blocks: []
estimated_loc: 350
files_touched:
  - src/channels/http/webui/index.html
  - src/channels/http/webui/app.js
  - src/channels/http/webui/style.css
  - src/channels/http/server.ts
  - tests/channels/http/webui.test.ts
---

# Local Web UI dashboard — vanilla HTML mounted on Bun.serve

## 1. Outcomes

- `http://127.0.0.1:17866/` (or configured port) serves a chat dashboard in the browser.
- User authenticates once by pasting a bearer token; an `HttpOnly + SameSite=Strict` cookie caches it so subsequent page loads require no re-entry.
- Live WS stream displays assistant text chunks, `tool_use` progress badges, and user messages echoed from all channels (Telegram, Slack) via SPEC-806 cursor replay.
- Refreshing the page restores the last 200 events from the SPEC-806 session log without a round-trip to the agent.
- No framework, no build step, no bundler. `GET /` returns a single self-contained HTML file.

## 2. Scope

### 2.1 In-scope

- `index.html` — shell page, CSP meta-tag, script/style tags pointing to same-origin paths
- `app.js` — vanilla ES2022 module: auth flow (token paste → cookie set), WS connect with `last-event-id`, event render loop, reconnect with backoff
- `style.css` — earth-brown palette matching SPEC-823 CLI theme; dark-mode via `prefers-color-scheme`
- `server.ts` modification: mount `/webui/` static files at `GET /`, `GET /app.js`, `GET /style.css` via `Bun.file`; CSP response header injected on every webui route
- `marked.min.js` vendored at `src/channels/http/webui/marked.min.js` (~30 KB); loaded via `<script src="/marked.min.js">` — no CDN reference
- Bearer token accepted via `Authorization` header on WS upgrade (SPEC-805 rule); cookie value forwarded by `app.js` as `Sec-WebSocket-Protocol` subprotocol (same pattern as SPEC-805 T3)
- WS primary; SSE (`/api/v1/events` endpoint) as fallback for environments where WS is blocked

### 2.2 Out-of-scope (v0.4+)

- Multi-user, OAuth, or federated identity
- SOUL.md / MEMORY.md editing UI
- Full cost dashboard (v0.3.1 shows read-only last-session cost line from SPEC-806 payload)
- Mobile / PWA manifest
- Lit web-components or any JS framework

## 3. Constraints

### Technical
- Vanilla JS only — no React, Svelte, Lit, or build toolchain
- Static bundle total size ≤40 KB uncompressed (excluding `marked.min.js` vendored asset); enforced in CI via `bun run bundle:size-check`
- CSP header on all webui routes: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*`
- Loopback-only bind enforced by SPEC-805 TLS rule; webui does not weaken that constraint
- Bearer token transport: `Authorization: Bearer <token>` header on WS upgrade; NEVER query-string (leaks in access logs)
- All user-supplied text rendered through `sanitise(text)` (strip tags, encode `<>&"`) before `innerHTML` assignment; `marked` output also sanitised

### Security
- Cookie set as `HttpOnly; SameSite=Strict; Path=/`; `Secure` flag added when TLS is active
- `app.js` must not reference `eval`, `Function()` constructor, or `document.write`; CI lint step (`grep -nP 'eval\(|new Function'`) fails the build if found
- XSS: no `innerHTML` assignments except through the sanitise wrapper; Markdown rendered via `marked.parse` then sanitised

### Performance
- Initial page load <300 ms on loopback (static files served from memory by `Bun.file`)
- First event rendered <500 ms after WS connect

## 4. Prior Decisions

- **Vanilla over Lit** — OpenClaw uses Lit web-components for its dashboard; nimbus skips this to avoid a build step and a runtime dependency. Lit's DOM diffing is unnecessary for a single-user local UI with modest update rates.
- **Mount on existing HTTP server** — spawning a second process or port would require additional firewall rules, a second bearer token, and more user config. Reusing SPEC-805 `Bun.serve` instance keeps the surface minimal.
- **Cookie caches bearer after first paste** — avoids repeated token pastes on page refresh; `HttpOnly` prevents JS token theft; `SameSite=Strict` blocks CSRF. Bearer token itself is never stored in `localStorage` or `sessionStorage`.
- **WS primary, SSE fallback** — WS is supported by all modern browsers. SSE (`EventSource`) works in environments where corporate firewalls block WS upgrades. SSE fallback uses the existing `/api/v1/stream` route from SPEC-805 with `text/event-stream` negotiation.
- **Bundle `marked.min.js` not roll own** — rolling a Markdown parser in <v0.3.1 timeline is risky; vendoring `marked` (BSD-2, ~30 KB) is safe and auditable. Re-evaluate in v0.4 if bundle size becomes a concern.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | `index.html` + `style.css`: shell page, auth form, message list, earth-brown palette | Visual: renders token paste form; after auth shows empty message list; dark-mode via media query | 80 | — |
| T2 | `server.ts`: mount webui static files; inject CSP response header; 401 without bearer | Unit: `GET /` with valid bearer → 200; without bearer → 401; CSP header present on every response | 30 | SPEC-805 T4 |
| T3 | `app.js`: token paste → cookie → WS connect with `last-event-id` from cookie or `sessionStorage` | Unit (jsdom): connect() resolves WebSocket; `last-event-id` header sent on reconnect | 100 | T2 |
| T4 | `app.js`: event render loop — `renderEvent` + `appendMessage` + `tool_use` badge | Unit (jsdom): `renderEvent` appends correct DOM node for `user`/`assistant`/`tool` roles; `marked` renders code block | 100 | T3 |
| T5 | `webui.test.ts`: HTTP serves files; CSP present; auth required; replay from cursor; bundle size check | All cases pass; `wc -c app.js style.css index.html` ≤40 KB | 40 | T2, T3, T4 |

## 6. Verification

### 6.1 Unit Tests (`tests/channels/http/webui.test.ts`)

- `GET /` without bearer → 401
- `GET /` with valid bearer → 200, `Content-Type: text/html`
- `GET /app.js` → 200, `Content-Type: application/javascript`
- Response header `Content-Security-Policy` present and matches spec value
- WS upgrade with valid bearer → 101; without → 401
- Bundle size: `Bun.file(...).size` for `app.js + style.css + index.html` combined ≤40 960 bytes

### 6.2 E2E Tests

- `tests/e2e/webui-smoke.test.ts` (Playwright, v0.4 — deferred): open `/` → paste token → send message → see streaming chunk; refresh → sees last 200 events.
- v0.3.1 smoke: `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17866/` → 200, body contains `<html`.

### 6.3 Security Checks

- `grep -nP 'eval\(|new Function'` on `app.js` → 0 matches (CI step)
- `grep -nP 'innerHTML\s*='` on `app.js` → all matches reference `sanitise(` wrapper (CI step)
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` (TLS mode)
- No `<script src="https://` anywhere in bundled files

## 7. Interfaces

```ts
// server.ts additions (TypeScript side)
export function mountWebUI(server: BunServer, cfg: HttpChannelConfig): void

// app.js (vanilla JS — TypeScript-style documentation only, not compiled)
interface DashboardState {
  sessionId: string | null
  lastEventId: string | null   // persisted in sessionStorage
  token: string | null         // set from cookie; never in localStorage
}

async function connect(token: string): Promise<WebSocket>
function renderEvent(e: SessionEvent, container: HTMLElement): void
function appendMessage(role: 'user' | 'assistant' | 'tool', text: string): void
function sanitise(raw: string): string   // strip tags + encode <>&"
```

## 8. Files Touched

- `src/channels/http/webui/index.html` (new, ~60 LoC)
- `src/channels/http/webui/app.js` (new, ~200 LoC)
- `src/channels/http/webui/style.css` (new, ~60 LoC)
- `src/channels/http/server.ts` (modify, +30 LoC — webui routes + CSP header)
- `tests/channels/http/webui.test.ts` (new, ~40 LoC)

## 9. Open Questions

- [ ] Bundle `marked.min.js` (~30 KB) or roll own Markdown parser? Bundle for v0.3.1; re-evaluate for v0.4 if size matters.

## 10. Changelog

- 2026-04-16 @hiepht: draft — v0.3.1 OpenClaw sync port — vanilla WebUI
