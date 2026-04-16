---
id: SPEC-306
title: MCP client integration — stdio + HTTP transports
status: draft
version: 0.1.0
owner: "@hiepht"
created: 2026-04-16
updated: 2026-04-16
release: v0.2
layer: tools
depends_on: [SPEC-301, SPEC-401, SPEC-151, META-003, META-009]
blocks: []
estimated_loc: 400
files_touched:
  - src/mcp/mcpConfig.ts
  - src/mcp/mcpClient.ts
  - src/mcp/transports.ts
  - src/mcp/toolTranslator.ts
  - src/mcp/serverLifecycle.ts
  - src/mcp/mcpNames.ts
  - tests/mcp/mcpClient.test.ts
  - tests/mcp/toolTranslator.test.ts
---

# MCP client — connect to external tool servers via Model Context Protocol

## 1. Outcomes

- Agent can connect to any MCP-compliant server (stdio + HTTP streamable) and use its tools
- MCP tools appear in agent's tool list at runtime via dynamic registration, namespaced `mcp__<server>__<tool>`
- All MCP tools route through SPEC-401 permission gate — no bypass, user must approve
- Server lifecycle managed with reconnect backoff; agent degrades gracefully when server unavailable
- Configuration via `.mcp.json` (project) or `workspace.json` `mcpServers` section

## 2. Scope

### 2.1 In-scope (v0.2 core — ~400 LoC)

- `McpServerConfig` Zod schema: stdio (command + args + env) and HTTP streamable (url + headers) types
- MCPClient using `@modelcontextprotocol/sdk`: connect, disconnect, callTool, listTools, listResources
- Transport adapters: `StdioClientTransport` + `StreamableHTTPClientTransport` from SDK
- Tool schema translator: MCP tool → Canonical IR tool registration with `mcp__<server>__<tool>` naming
- Server lifecycle: connect on first tool call (lazy), reconnect with exponential backoff (1s-30s, max 5 attempts), healthcheck via `ping`
- Permission gate: MCP tools route through SPEC-401 with `passthrough` (requires user approval per tool call)
- Config loader: read `.mcp.json` (project-scope) + `workspace.json` `mcpServers` (user-scope), env var expansion
- Security hardening: sanitize subprocess env (strip ANTHROPIC_API_KEY/OPENAI_API_KEY etc.), cap tool description to 2048 chars, cap tool output to 100KB, namespace tool names (prevent collision with built-ins), project-scope servers require first-use approval
- Resource support: `listResources` + `readResource` exposed as read-only data (no tool call overhead)

### 2.2 Out-of-scope (v0.3+)

- SSE transport — defer to v0.3 (streamable HTTP covers most cases)
- WebSocket transport — defer to v0.3
- OAuth/OIDC auth for MCP servers — defer to v0.3 (v0.2 supports API key via headers only)
- MCP server hosting (nimbus acting as server) — v0.4
- Enterprise allowlist/denylist policy — v0.3
- Prompt template injection from MCP `instructions` — v0.3 (requires content-trust layer SPEC-45x)

## 3. Constraints

### Technical
- Depends on `@modelcontextprotocol/sdk` npm package (MIT, official)
- Bun-native: `Bun.spawn` for stdio transport; `Bun.fetch` for HTTP
- TypeScript strict, max 400 LoC per file, no `any`
- MCP tool output treated as untrusted: wrapped in `<tool_output trusted="false">` per META-009

### Performance
- Connection timeout: 30s
- Tool call timeout: 60s default (configurable per-server)
- Lazy connect: no startup penalty; first tool call triggers connect

### Security
- Subprocess env sanitized: strip `*_API_KEY`, `*_TOKEN`, `*_SECRET` patterns from MCP server env
- Tool name collision: built-in tools ALWAYS win; MCP tools prefixed `mcp__`
- Tool description/output capped to prevent prompt inflation
- Project-scope `.mcp.json` servers require explicit approval on first use

## 4. Prior Decisions

- **`@modelcontextprotocol/sdk` over custom JSON-RPC** — SDK handles protocol negotiation, capability discovery, transport lifecycle. Claude Code uses it (src/services/mcp/client.ts:595). Saves ~800 LoC vs raw implementation.
- **Lazy connect over eager** — don't penalize startup when user hasn't invoked MCP tools yet. Claude Code memoizes connections; nimbus lazy-inits on first tool call.
- **`mcp__<server>__<tool>` naming** — Claude Code convention (src/services/mcp/mcpStringUtils.ts). Prevents collision with built-in tools. Built-ins always win on bare name.
- **Passthrough permission (user confirms each call)** — MCP tools are external code; no auto-allow even for trusted-looking names. Claude Code MCPTool.ts uses passthrough.
- **Env sanitization** — Claude Code's `subprocessEnv()` strips sensitive vars. MCP servers inherit nimbus process env by default; must strip secrets.
- **stdio + HTTP only for v0.2** — SSE is legacy MCP transport; streamable HTTP is the current spec. Covers 90%+ of MCP servers.
- **60s tool timeout** — generous for slow MCP servers (data queries, browser automation). Configurable per-server for tighter budgets.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | McpServerConfig Zod schema (stdio + http) | validate + reject malformed, env expansion | 60 | — |
| T2 | MCPClient: connect + callTool + listTools + listResources | mock server round-trip, timeout, error classify | 120 | T1 |
| T3 | Transport adapters (stdio + HTTP streamable) | stdio fork works, HTTP POST works | 60 | T2 |
| T4 | Tool translator: MCP tool → Canonical IR + namespace | 10-case fixtures, built-in collision → MCP loses | 50 | T2 |
| T5 | Server lifecycle: lazy connect + reconnect backoff + healthcheck | reconnect after kill, max 5 attempts | 60 | T2 |
| T6 | Permission gate: MCP tools through SPEC-401 | passthrough mode, no auto-allow | 30 | T4 |
| T7 | Config loader: .mcp.json + workspace.json + env expansion | multi-scope merge, env var expand | 50 | T1 |
| T8 | Security: env sanitize + cap desc/output + project approval | API key stripped from env, 100KB output cap | 40 | T2 |

## 6. Verification

### 6.1 Unit Tests
- Config schema: accept valid stdio/http, reject malformed, env expansion
- Tool translator: 10-case MCP→IR fixtures, namespace collision, description cap
- Lifecycle: reconnect backoff timing, max attempts, healthcheck timeout

### 6.2 E2E Tests
- Spawn a mock MCP stdio server → nimbus connects → listTools → callTool → verify result
- HTTP transport → same flow against mock HTTP server
- Server crash mid-call → reconnect → retry succeeds

### 6.3 Security Checks
- Env sanitization: ANTHROPIC_API_KEY not in MCP server subprocess env
- Tool output >100KB → truncated
- Project-scope server without approval → rejected with banner
- MCP tool named `Read` (collision with built-in) → `mcp__server__Read` used, built-in `Read` unaffected

## 7. Interfaces

```ts
const McpStdioConfig = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpHttpConfig = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

type McpServerConfig = z.infer<typeof McpStdioConfig> | z.infer<typeof McpHttpConfig>;

interface McpToolDescriptor {
  name: string;           // mcp__<server>__<tool>
  description: string;    // capped 2048 chars
  inputSchema: unknown;   // JSON Schema from MCP
  serverName: string;
}

function buildMcpToolName(server: string, tool: string): string;
function sanitizeSubprocessEnv(env: Record<string, string>): Record<string, string>;
```

## 8. Files Touched

- `src/mcp/mcpConfig.ts` (new, ~60 LoC)
- `src/mcp/mcpClient.ts` (new, ~120 LoC)
- `src/mcp/transports.ts` (new, ~60 LoC)
- `src/mcp/toolTranslator.ts` (new, ~50 LoC)
- `src/mcp/serverLifecycle.ts` (new, ~60 LoC)
- `src/mcp/mcpNames.ts` (new, ~30 LoC)
- `tests/mcp/mcpClient.test.ts` (new, ~150 LoC)
- `tests/mcp/toolTranslator.test.ts` (new, ~80 LoC)

## 9. Open Questions

- [ ] Should nimbus auto-discover `.mcp.json` in parent directories? (Claude Code does — adopt v0.3?)
- [ ] MCP prompt templates: inject into system prompt or offer as skills? (defer v0.3)

## 10. Changelog

- 2026-04-16 @hiepht: draft — based on Claude Code MCP reverse-engineering (src/services/mcp/ ~10K LoC reference)
