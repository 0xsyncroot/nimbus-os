// SPEC-206 T2 — resolver: capability detect + effort precedence (session > cue > default).
import { logger } from '../observability/logger.ts';
import type { EffortLevel } from './reasoningCue.ts';

export type { EffortLevel };

export interface ResolvedReasoning {
  effort: EffortLevel;
  applied: boolean; // true when model accepts reasoning params
}

export interface ResolveInput {
  modelId: string;
  cueEffort: EffortLevel | null;
  sessionEffort: EffortLevel | null;
}

// OpenAI o-series + gpt-5+ match (aligned with SPEC-203 isReasoningModel, kept local to
// avoid cross-module coupling — the two may diverge if Anthropic ever ships reasoning on
// Sonnet-5+ but OpenAI adds a different naming scheme).
const OPENAI_REASONING_RE = /^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i;

// Curated set of Anthropic extended-thinking models (spec §2.1).
const ANTHROPIC_THINKING_MODELS: readonly string[] = [
  'opus-4-6',
  'sonnet-4-5',
  'sonnet-4-6',
];

export function isReasoningCapable(modelId: string): boolean {
  if (OPENAI_REASONING_RE.test(modelId)) return true;
  const m = modelId.toLowerCase();
  return ANTHROPIC_THINKING_MODELS.some((s) => m.includes(s));
}

function pickEffort(input: ResolveInput): EffortLevel {
  if (input.sessionEffort !== null && input.sessionEffort !== undefined) {
    return input.sessionEffort;
  }
  if (input.cueEffort !== null && input.cueEffort !== undefined) {
    return input.cueEffort;
  }
  return 'medium';
}

export function resolveReasoning(input: ResolveInput): ResolvedReasoning {
  const capable = isReasoningCapable(input.modelId);
  if (!capable) {
    const requested = input.sessionEffort ?? input.cueEffort;
    if (requested && requested !== 'off') {
      logger.debug(
        { modelId: input.modelId, requested, msg: 'reasoning dropped' },
        'reasoning_capability_drop',
      );
    }
    return { effort: 'off', applied: false };
  }
  const chosen = pickEffort(input);
  if (chosen === 'off') return { effort: 'off', applied: false };
  return { effort: chosen, applied: true };
}

// ----- provider adapter helpers -----

// Budget mapping — modest defaults; adaptive ramp deferred to v0.2.
const BUDGET_BY_EFFORT: Record<Exclude<EffortLevel, 'off'>, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
};

export function toAnthropicThinking(
  r: ResolvedReasoning,
): { thinking: { type: 'enabled'; budget_tokens: number } } | Record<string, never> {
  if (!r.applied || r.effort === 'off') return {};
  return {
    thinking: {
      type: 'enabled',
      budget_tokens: BUDGET_BY_EFFORT[r.effort],
    },
  };
}

export function toOpenAIReasoningEffort(
  r: ResolvedReasoning,
): { reasoning_effort: 'low' | 'medium' | 'high' } | Record<string, never> {
  if (!r.applied || r.effort === 'off') return {};
  if (r.effort === 'high') return { reasoning_effort: 'high' };
  if (r.effort === 'low' || r.effort === 'minimal') return { reasoning_effort: 'low' };
  return { reasoning_effort: 'medium' };
}

// Parser for `/thinking <arg>` — whitelisted values + ergonomic `on` → medium.
export function parseThinkingArg(raw: string): EffortLevel {
  const v = raw.trim().toLowerCase();
  if (v === 'on') return 'medium';
  if (v === 'off' || v === 'minimal' || v === 'low' || v === 'medium' || v === 'high') {
    return v;
  }
  throw new ThinkingParseError(v);
}

export class ThinkingParseError extends Error {
  constructor(public readonly badArg: string) {
    super(`invalid /thinking argument: ${badArg}`);
    this.name = 'ThinkingParseError';
  }
}
