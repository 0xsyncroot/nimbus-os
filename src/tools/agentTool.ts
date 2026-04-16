// agentTool.ts — SPEC-131 T3: AgentTool blocking sub-agent spawn + trust wrap.
// sideEffects: 'exec' (SPEC-301 partition). Cancellation via parent AbortController.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { createSubAgentRuntime } from '../core/subAgent/runtime.ts';
import { createTurnAbort } from '../core/cancellation.ts';
import { getOrCreateMailbox } from './subAgent/mailbox.ts';
import { wrapUntrusted } from './subAgent/trustWrap.ts';
import type { Tool } from './types.ts';
import type { TurnContext } from '../core/turn.ts';
import type { Provider } from '../ir/types.ts';

const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

export const AgentToolInputSchema = z.object({
  type: z.string().min(1).describe('Sub-agent role/type identifier (e.g., "researcher", "coder")'),
  prompt: z.string().min(1).describe('Task instructions for the sub-agent'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in ms (default 5 min)'),
  narrowBash: z.array(z.string()).optional().describe('Bash command patterns to allow (intersected with parent)'),
  denyTools: z.array(z.string()).optional().describe('Tool names to deny in the sub-agent'),
}).strict();

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

export interface AgentToolOutput {
  subAgentId: string;
  outcome: string;
  result: string;
}

export function createAgentTool(): Tool<AgentToolInput, AgentToolOutput> {
  const runtime = createSubAgentRuntime({ backend: 'inproc' });

  return {
    name: 'AgentTool',
    description:
      'Spawn a sub-agent to handle a parallel task (research, investigation). ' +
      'Blocks until the sub-agent completes. Returns trust-wrapped output.',
    readOnly: false,
    dangerous: true,
    inputSchema: AgentToolInputSchema,
    async handler(input, ctx) {
      const timeout = input.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

      // Ensure mailbox exists for this session before spawn.
      const parentMailbox = getOrCreateMailbox(ctx.workspaceId, ctx.sessionId, false);
      void parentMailbox;

      logger.info(
        { type: input.type, timeout, workspaceId: ctx.workspaceId },
        'AgentTool: spawning sub-agent',
      );

      // Build a minimal TurnContext for the sub-agent. The runtime overrides
      // sessionId, mode, and abort — so we only need valid types here.
      // provider is unavailable from ToolContext, so we use a stub that
      // will be replaced when the runtime wires the real loop via runTurn.
      const subCtxBase: TurnContext = {
        sessionId: ctx.sessionId,
        wsId: ctx.workspaceId,
        channel: 'cli',
        mode: ctx.mode,
        abort: createTurnAbort(ctx.signal),
        provider: null as unknown as Provider, // runtime replaces before use
        model: 'claude-sonnet-4-6',
      };

      let result;
      try {
        result = await runtime.spawn({
          parentId: ctx.sessionId,
          parentSignal: ctx.signal,
          parentMode: ctx.mode,
          parentDepth: 0,
          prompt: input.prompt,
          narrowBash: input.narrowBash,
          denyTools: input.denyTools,
          timeoutMs: timeout,
          ctx: subCtxBase,
        });
      } catch (err) {
        if (err instanceof NimbusError) throw err;
        throw new NimbusError(ErrorCode.Y_SUBAGENT_CRASH, {
          reason: 'spawn_failed',
          type: input.type,
          err: (err as Error).message,
        });
      }

      if (result.outcome === 'timeout') {
        throw new NimbusError(ErrorCode.T_TIMEOUT, {
          reason: 'sub_agent_timeout',
          subAgentId: result.id,
          timeoutMs: timeout,
        });
      }

      // Wrap sub-agent output as untrusted (prompt injection defense).
      const rawOutput = result.output ?? result.error ?? '(no output)';
      const wrapped = wrapUntrusted(rawOutput, `sub:${result.id}`);

      return {
        ok: true,
        output: {
          subAgentId: result.id,
          outcome: result.outcome,
          result: wrapped.text,
        },
        display: wrapped.text,
      };
    },
  };
}
