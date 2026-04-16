// turn.ts — SPEC-103: TurnContext + LoopOutput types only.

import type { CanonicalChunk, Provider } from '../ir/types.ts';
import type { TurnAbort } from './cancellation.ts';

export type ChannelKind = 'cli' | 'http' | 'ws' | 'telegram' | 'slack';
export type AgentMode = 'readonly' | 'default' | 'bypass' | 'plan' | 'acceptEdits';

export interface TurnContext {
  sessionId: string;
  wsId: string;
  channel: ChannelKind;
  mode: AgentMode;
  abort: TurnAbort;
  provider: Provider;
  model: string;
}

export interface TurnMetric {
  turnId: string;
  sessionId: string;
  outcome: 'ok' | 'error' | 'cancelled';
  ms: number;
  iterations: number;
  errorCode?: string;
  model?: string;
}

export type LoopOutput =
  | { kind: 'chunk'; chunk: CanonicalChunk }
  | { kind: 'plan_announce'; reason: string; heuristic: string }
  | { kind: 'spec_announce'; summary: string }
  | { kind: 'tool_start'; toolUseId: string; name: string }
  | { kind: 'tool_end'; toolUseId: string; ok: boolean; ms: number }
  | { kind: 'turn_end'; metric: TurnMetric };

export const MAX_TOOL_ITERATIONS = 30;
