---
id: SPEC-201
title: Canonical IR types + helpers
status: implemented
version: 0.1.0
owner: "@hiepht"
created: 2026-04-15
updated: 2026-04-15
release: v0.1
layer: ir
depends_on: [META-004]
blocks: [SPEC-202, SPEC-203, SPEC-102, SPEC-103]
estimated_loc: 140
files_touched:
  - src/ir/types.ts
  - src/ir/helpers.ts
  - src/ir/capabilities.ts
  - src/ir/schemas.ts
  - tests/ir/helpers.test.ts
  - tests/ir/schemas.test.ts
---

# Canonical IR Types + Helpers

## 1. Outcomes

- Core loop + storage + channels speak ONE message format regardless of provider
- Swap Anthropic ↔ OpenAI-compat without touching `src/core/`, `src/storage/`, `src/channels/`
- `extractText(msg)` returns concatenated text in <1ms for 100-block messages
- Round-trip serialize → deserialize preserves every block (including `cacheHint`, `signature`)

## 2. Scope

### 2.1 In-scope
- `CanonicalBlock` union, `CanonicalMessage`, `CanonicalChunk`, `CanonicalRequest` types
- `ProviderCapabilities` + `Provider` interfaces
- Zod schemas for runtime validation at storage/wire boundary
- Helpers: `extractText`, `mergeAdjacentText`, `splitByType`, `isToolUse`, `isToolResult`, `newToolUseId`
- Type guards for each block variant

### 2.2 Out-of-scope (defer to other specs)
- Anthropic adaption → SPEC-202
- OpenAI-compat adaption → SPEC-203
- Persistence format (JSONL layout) → SPEC-102
- Token counting → each provider's `countTokens()` (SPEC-202/203)

## 3. Constraints

### Technical
- Layer rule (META-004): `src/ir/` MUST NOT import from `core/`, `tools/`, `platform/`, `storage/`, or `bun:*`
- Pure TS — no Bun-specific APIs (mobile client reuse)
- TypeScript strict, no `any`, `noUncheckedIndexedAccess`
- Max 400 LoC per file; split `types.ts` vs `helpers.ts` vs `schemas.ts`

### Performance
- `extractText(msg)` <1ms for 100-block message (benchmarked)
- Zod parse of 1KB CanonicalMessage <0.5ms warm

## 4. Prior Decisions

- **Anthropic-shaped superset, not lowest-common-denominator** (META-004 §3). Downgrading to OpenAI is trivial; upgrading loses info like `thinking`/`cacheHint`.
- **`toolUseId` camelCase internally** — adapters translate at wire boundary only. Convention locked (META-010). Avoids ambiguity between Anthropic `tool_use_id` and OpenAI `tool_call_id`.
- **Zod only at boundaries (storage load, wire decode)** — not every internal pass-through. Pure TS `type` is source of truth; Zod schema is runtime witness.
- **ULID for `newToolUseId`** — matches SPEC-101 `workspaceId` + SPEC-102 `sessionId` convention. Lexicographic sort = insertion order (helpful in JSONL debugging). Pure-JS `ulid` package, no native deps.
- **`ToolDefinition` imported from SPEC-301** — re-exported through `src/ir/types.ts` to keep IR the sole entry point for core/storage consumers. Interface-only import, zero runtime coupling to `src/tools/`.

## 5. Task Breakdown

| ID | Task | Acceptance criteria | Est LoC | Depends |
|----|------|---------------------|---------|---------|
| T1 | Define `CanonicalBlock`/`Message`/`Chunk`/`Request` type unions in `types.ts` | compiles strict; union exhaustiveness check via `assertNever` | 40 | — |
| T2 | `ProviderCapabilities` + `Provider` interface in `capabilities.ts` | fields match META-004 §2.2 exactly | 20 | T1 |
| T3 | Zod schemas mirroring types in `schemas.ts` | round-trip `z.parse(z.parse(x).data)` equal | 40 | T1 |
| T4 | Helpers in `helpers.ts`: `extractText`, `mergeAdjacentText`, `splitByType`, type guards, `newToolUseId` (ULID) | unit tests green | 40 | T1 |

## 6. Verification

### 6.1 Unit Tests
- `tests/ir/helpers.test.ts`:
  - `extractText` returns `""` for empty content, concatenates text blocks, ignores non-text
  - `mergeAdjacentText` combines `[{type:'text',text:'a'},{type:'text',text:'b'}]` → one block, preserves cacheHint from last
  - `isToolUse` narrows type correctly (tsc test)
  - `newToolUseId` returns ULID matching `/^[0-9A-Z]{26}$/`
- `tests/ir/schemas.test.ts`:
  - Zod rejects missing `role`, unknown block `type`
  - Round-trip: `schema.parse(msg)` equals `msg` for every variant

### 6.3 Performance Budgets
- `extractText` on 100-block msg <1ms (`bun test --bench`)

### 6.4 Security Checks
- Schema rejects blocks with unexpected keys (strict Zod `.strict()`)
- `tool_result.content` recursive schema bounded depth ≤3 (prevent DoS from crafted nesting)

## 7. Interfaces

```ts
// types.ts — source of truth
export type CanonicalBlock =
  | { type: 'text'; text: string; cacheHint?: 'ephemeral' }
  | { type: 'image'; source: { kind: 'base64' | 'url'; data: string; mimeType: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string | CanonicalBlock[]; isError?: boolean }
  | { type: 'thinking'; text: string; signature?: string }

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | CanonicalBlock[]
}

export interface CanonicalRequest {
  messages: CanonicalMessage[]
  system?: CanonicalBlock[]
  tools?: ToolDefinition[]
  model: string
  maxTokens?: number
  temperature?: number
  stream: true
}

export type CanonicalChunk =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'content_block_start'; index: number; block: CanonicalBlock }
  | { type: 'content_block_delta'; index: number; delta: Partial<CanonicalBlock> }
  | { type: 'content_block_stop'; index: number }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'message_stop'; finishReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' }
  | { type: 'error'; code: string; message: string }

// capabilities.ts
export interface ProviderCapabilities {
  nativeTools: boolean
  promptCaching: 'explicit' | 'implicit' | 'none'
  vision: 'base64' | 'url' | 'both' | 'none'
  extendedThinking: boolean
  maxContextTokens: number
  supportsStreamingTools: boolean
  supportsParallelTools: boolean
}

export interface Provider {
  readonly id: string
  capabilities(): ProviderCapabilities
  stream(req: CanonicalRequest, opts: { signal: AbortSignal }): AsyncIterable<CanonicalChunk>
  countTokens?(msgs: CanonicalMessage[]): Promise<number>
}

// schemas.ts
export const CanonicalBlockSchema: z.ZodType<CanonicalBlock> = z.discriminatedUnion('type', [...]).strict()
export const CanonicalMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(CanonicalBlockSchema)]),
}).strict()

// helpers.ts
export function extractText(msg: CanonicalMessage): string
export function mergeAdjacentText(blocks: CanonicalBlock[]): CanonicalBlock[]
export function splitByType<T extends CanonicalBlock['type']>(blocks: CanonicalBlock[], type: T): Extract<CanonicalBlock, { type: T }>[]
export function isToolUse(b: CanonicalBlock): b is Extract<CanonicalBlock, { type: 'tool_use' }>
export function isToolResult(b: CanonicalBlock): b is Extract<CanonicalBlock, { type: 'tool_result' }>
export function newToolUseId(): string  // ULID via `ulid` package

// ToolDefinition — defined in SPEC-301, re-exported here
export type { ToolDefinition } from '../tools/types'
```

## 8. Files Touched

- `src/ir/types.ts` (new, ~40 LoC)
- `src/ir/capabilities.ts` (new, ~20 LoC)
- `src/ir/schemas.ts` (new, ~40 LoC)
- `src/ir/helpers.ts` (new, ~40 LoC)
- `tests/ir/helpers.test.ts` (new, ~80 LoC)
- `tests/ir/schemas.test.ts` (new, ~60 LoC)

## 9. Open Questions

*(none — ULID decision committed in §4)*

## 10. Changelog

- 2026-04-15 @hiepht: draft initial
- 2026-04-15 @hiepht: review revisions — commit ULID decision; document `ToolDefinition` re-export from SPEC-301
