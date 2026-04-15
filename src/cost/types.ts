// types.ts — SPEC-701: CostEvent schema + usage/rollup types.

import { z } from 'zod';

export const ProviderSchema = z.enum([
  'anthropic',
  'openai',
  'groq',
  'deepseek',
  'ollama',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelClassSchema = z.enum([
  'flagship',
  'workhorse',
  'budget',
  'reasoning',
  'local',
]);
export type ModelClass = z.infer<typeof ModelClassSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CostEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  agentId: z.string().optional(),
  parentAgentId: z.string().optional(),
  channel: z.string().min(1),
  skillName: z.string().optional(),
  toolName: z.string().optional(),
  provider: ProviderSchema,
  model: z.string().min(1),
  modelClass: ModelClassSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative(),
  costSavedUsd: z.number().nonnegative().default(0),
  isDream: z.boolean().optional(),
  isMicrocompact: z.boolean().optional(),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

export interface CostRollup {
  totalUsd: number;
  byProvider: Record<string, number>;
  bySession: Record<string, number>;
  byDay: Record<string, number>;
  events: number;
}

export type AggregateWindow = 'today' | 'week' | 'month';
