// modelClasses.ts — SPEC-106: ModelClass union + default routing table.

import { z } from 'zod';

export const MODEL_CLASSES = ['flagship', 'workhorse', 'budget', 'reasoning', 'local'] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const ResolvedModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const ModelRoutingSchema = z.record(
  z.enum(MODEL_CLASSES),
  ResolvedModelSchema,
);
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

export const DEFAULT_ROUTING: ModelRouting = {
  flagship: { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
  workhorse: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
  budget: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  reasoning: { providerId: 'anthropic', modelId: 'claude-opus-4-6' },
  local: { providerId: 'ollama', modelId: 'llama3' },
};

export const MAX_ROUTING_ENTRIES = 50;
