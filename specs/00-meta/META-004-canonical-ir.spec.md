---
id: META-004
title: Canonical IR — provider-agnostic message + capabilities contract
status: approved
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
layer: meta
depends_on: []
---

# Canonical Intermediate Representation (IR)

## 1. Purpose

Define a single provider-agnostic wire format that core loop, storage, and channels use. Providers (Anthropic, OpenAI-compat) adapt INTO/OUT OF this format at boundaries. Enables:
- Multi-provider without core rewrites
- Mobile client reuse (pure TS)
- Session storage stable across provider changes

## 2. Contract

### 2.1 CanonicalBlock union (Anthropic-shaped, expressive superset)

schemaVersion=2: all variants carry optional `trust?: 'trusted'|'untrusted'`. Missing field → 'trusted' default.

```ts
export type CanonicalBlock =
  | { type: 'text'; text: string; cacheHint?: 'ephemeral'; trust?: 'trusted'|'untrusted'; origin?: string }
  | { type: 'image'; source: { kind: 'base64' | 'url'; data: string; mimeType: string }; trust?: 'trusted'|'untrusted' }
  | { type: 'tool_use'; id: string; name: string; input: unknown; trust?: 'trusted'|'untrusted' }
  | { type: 'tool_result'; toolUseId: string; content: string | CanonicalBlock[]; isError?: boolean; trust?: 'trusted'|'untrusted' }
  | { type: 'thinking'; text: string; signature?: string; trust?: 'trusted'|'untrusted' }

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | CanonicalBlock[]
}

export type CanonicalChunk =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'content_block_start'; index: number; block: CanonicalBlock }
  | { type: 'content_block_delta'; index: number; delta: Partial<CanonicalBlock> }
  | { type: 'content_block_stop'; index: number }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'message_stop'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'error'; code: string; message: string }
```

### 2.2 ProviderCapabilities

```ts
export interface ProviderCapabilities {
  nativeTools: boolean                               // native tool_use or prompt-guided fallback
  promptCaching: 'explicit' | 'implicit' | 'none'    // Anthropic explicit, OpenAI implicit, others none
  vision: 'base64' | 'url' | 'both' | 'none'
  extendedThinking: boolean                           // Claude Sonnet/Opus thinking
  maxContextTokens: number
  supportsStreamingTools: boolean
  supportsParallelTools: boolean
}
```

### 2.3 Provider interface

```ts
export interface Provider {
  readonly id: string                    // 'anthropic' | 'openai-compat:groq' | 'ollama:llama3'
  capabilities(): ProviderCapabilities
  stream(req: CanonicalRequest, opts: StreamOpts): AsyncIterable<CanonicalChunk>
  countTokens?(msgs: CanonicalMessage[]): Promise<number>
}

export interface CanonicalRequest {
  messages: CanonicalMessage[]
  system?: CanonicalBlock[]              // supports cacheHint per block
  tools?: ToolDefinition[]
  model: string
  maxTokens?: number
  temperature?: number
  stream: true
}
```

### 2.4 Normalization rules (provider adapter boundary)

| Feature | Anthropic | OpenAI-compat | Adapter behavior |
|---------|-----------|---------------|------------------|
| Tool call | `content[{type:"tool_use",id,name,input}]` | `tool_calls[{id,function:{name,arguments}}]` | bi-directional map |
| Tool result | In user turn: `{type:"tool_result",tool_use_id,content}` | Separate `role:"tool"` msg | OpenAI adapter splits each into separate message |
| System | `system: string \| array of blocks with cache_control` | First msg `role:"system"` | OpenAI adapter flattens blocks, drops cacheHint |
| Cache | `cache_control: {type:"ephemeral"}` markers | No markers (implicit prefix cache) | Only attach when `caps.promptCaching === 'explicit'` |
| Vision | base64 or URL | base64 or URL (gpt-4o) | No conversion needed |
| Thinking | `{type:"thinking",text,signature}` blocks | Not supported (o1 hides) | OpenAI adapter **filters thinking blocks out** |

### 2.5 Identifier convention

- Internal: `toolUseId` (camelCase) in all CanonicalBlock types
- Wire: adapters translate `toolUseId` ↔ `tool_use_id` (Anthropic) or `tool_call_id` (OpenAI)

## 3. Rationale

- **Anthropic-shaped superset**: Anthropic IR is more expressive (blocks, cache markers, thinking). Downgrading is trivial; upgrading loses info.
- **Pure TS, no Bun**: enables mobile client reuse without runtime constraints.
- **Capabilities flag**: core loop adapts (e.g., skip micro-compact if `promptCaching !== 'explicit'`). Avoid feature detection scattered across codebase.

## 4. Consumers

- SPEC-201 (IR types + helpers)
- SPEC-202 (Anthropic adapter)
- SPEC-203 (OpenAI-compat adapter)
- SPEC-102 (session storage — persist CanonicalMessage format)
- SPEC-103 (agent loop — emits CanonicalChunks to channels)

## 5. Evolution Policy

Adding new CanonicalBlock variant:
- Must be gracefully ignored by old providers (e.g., thinking — OpenAI strips, no crash)
- Bump IR schema version in storage migration

## 6. Schema Versioning

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-15 | Initial release |
| v2 | 2026-04-16 | Add `trust?: 'trusted'\|'untrusted'` optional field to all CanonicalBlock variants (SPEC-131). Missing field → default `'trusted'` (backward compat). |

Migration rule: consumers reading stored CanonicalBlocks from v1 storage must treat absent `trust` as `'trusted'`.

## 7. Changelog

- 2026-04-15 @hiepht: initial + approve
- 2026-04-16 @hiepht: v2 — add `trust?` + `origin?` fields to CanonicalBlock (SPEC-131 sub-agent trust boundary). schemaVersion bumped 1→2. Backward compat: missing field = 'trusted'.
