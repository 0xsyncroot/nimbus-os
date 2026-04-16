// types.ts — SPEC-301: Tool interface + ToolContext.

import type { ZodTypeAny } from 'zod';
import type { Logger } from '../observability/logger.ts';
import type { NimbusError } from '../observability/errors.ts';
import type { Gate } from '../permissions/gate.ts';
import type { CanonicalBlock, ToolDefinition } from '../ir/types.ts';

export interface ToolContext {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onAbort: (cleanup: () => void) => void;
  readonly permissions: Gate;
  readonly mode: 'default' | 'readonly' | 'bypass' | 'plan' | 'acceptEdits';
  readonly logger: Logger;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly readOnly: boolean;
  readonly dangerous?: boolean;
  handler(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

export type ToolResult<O = unknown> =
  | { ok: true; output: O; display?: string }
  | { ok: false; error: NimbusError; display?: string };

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  toolUseId: string;
  block: Extract<CanonicalBlock, { type: 'tool_result' }>;
}

export type { ToolDefinition };
