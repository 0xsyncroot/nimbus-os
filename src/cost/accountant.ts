// accountant.ts — SPEC-701 T3: recordCost entry point.

import { newToolUseId } from '../ir/helpers.ts';
import { appendCostEvent } from './ledger.ts';
import { computeCost, resolveClass } from './priceTable.ts';
import {
  CostEventSchema,
  ProviderSchema,
  TokenUsageSchema,
  type CostEvent,
  type Provider,
  type TokenUsage,
} from './types.ts';

export interface RecordCostInput {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  channel: string;
  agentId?: string;
  parentAgentId?: string;
  skillName?: string;
  toolName?: string;
  isDream?: boolean;
  isMicrocompact?: boolean;
  /** Override ts (for tests); defaults to Date.now(). */
  ts?: number;
}

export interface Accountant {
  recordCost(input: RecordCostInput): Promise<CostEvent>;
}

function assertProvider(p: string): Provider {
  const parsed = ProviderSchema.safeParse(p);
  if (!parsed.success) {
    // Accept unknown as a generic fallback → price 0, class local (via priceTable).
    // But the ledger schema enforces the 5-value enum, so coerce to closest.
    return 'anthropic';
  }
  return parsed.data;
}

export async function recordCost(input: RecordCostInput): Promise<CostEvent> {
  const usage = TokenUsageSchema.parse(input.usage);
  const provider = assertProvider(input.provider);
  const { costUsd, costSavedUsd } = computeCost(usage, provider, input.model);
  const modelClass = resolveClass(provider, input.model);
  const event: CostEvent = CostEventSchema.parse({
    schemaVersion: 1,
    id: newToolUseId(),
    ts: input.ts ?? Date.now(),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    channel: input.channel,
    skillName: input.skillName,
    toolName: input.toolName,
    provider,
    model: input.model,
    modelClass,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    costUsd,
    costSavedUsd,
    isDream: input.isDream,
    isMicrocompact: input.isMicrocompact,
  });
  await appendCostEvent(event);
  return event;
}

export const accountant: Accountant = { recordCost };
