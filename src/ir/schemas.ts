// Zod schemas mirroring CanonicalBlock/Message (SPEC-201 T3).
// Used at boundaries: storage load, wire decode. Internal code uses the TS types directly.
import { z } from 'zod';
import type { CanonicalBlock } from './types';

const MAX_TOOL_RESULT_DEPTH = 3;

export const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    cacheHint: z.literal('ephemeral').optional(),
  })
  .strict();

export const ImageBlockSchema = z
  .object({
    type: z.literal('image'),
    source: z
      .object({
        kind: z.enum(['base64', 'url']),
        data: z.string(),
        mimeType: z.string(),
      })
      .strict(),
  })
  .strict();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .strict();

export const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    text: z.string(),
    signature: z.string().optional(),
  })
  .strict();

// Recursive tool_result — bound depth to prevent DoS via crafted nesting.
function toolResultSchema(depth: number): z.ZodType<
  Extract<CanonicalBlock, { type: 'tool_result' }>
> {
  const contentSchema: z.ZodType<string | CanonicalBlock[]> =
    depth <= 0
      ? z.string()
      : z.union([
          z.string(),
          z.array(blockSchema(depth - 1)),
        ]);
  return z
    .object({
      type: z.literal('tool_result'),
      toolUseId: z.string().min(1),
      content: contentSchema,
      isError: z.boolean().optional(),
    })
    .strict() as z.ZodType<Extract<CanonicalBlock, { type: 'tool_result' }>>;
}

function blockSchema(depth: number): z.ZodType<CanonicalBlock> {
  return z.union([
    TextBlockSchema,
    ImageBlockSchema,
    ToolUseBlockSchema,
    toolResultSchema(depth),
    ThinkingBlockSchema,
  ]) as z.ZodType<CanonicalBlock>;
}

export const CanonicalBlockSchema: z.ZodType<CanonicalBlock> = blockSchema(
  MAX_TOOL_RESULT_DEPTH,
);

export const CanonicalMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([z.string(), z.array(CanonicalBlockSchema)]),
  })
  .strict();
