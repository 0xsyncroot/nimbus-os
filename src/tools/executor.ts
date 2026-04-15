// executor.ts — SPEC-301: runs a batch of tool calls from one LLM turn.

import { z } from 'zod';
import { ErrorCode, NimbusError, classify } from '../observability/errors.ts';
import { logger as rootLogger } from '../observability/logger.ts';
import type { CanonicalBlock } from '../ir/types.ts';
import type { Gate } from '../permissions/gate.ts';
import type { ToolRegistry } from './registry.ts';
import { partitionToolCalls } from './partition.ts';
import { createCancellationScope } from './cancellation.ts';
import type {
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolResultBlock,
} from './types.ts';

export interface ExecutorRunContext {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  mode: 'default' | 'readonly' | 'bypass';
  permissions: Gate;
  parentSignal: AbortSignal;
}

export interface ToolExecutor {
  run(
    calls: ToolCall[],
    ctx: ExecutorRunContext,
  ): Promise<ToolResultBlock[]>;
}

export interface CreateExecutorOptions {
  registry: ToolRegistry;
  readConcurrency?: number;
}

const DEFAULT_READ_CONCURRENCY = 10;

export function createExecutor(opts: CreateExecutorOptions): ToolExecutor {
  const readConcurrency = opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
  return {
    async run(calls, ctx): Promise<ToolResultBlock[]> {
      const { reads, writes } = partitionToolCalls(calls, opts.registry);
      const results = new Map<string, ToolResultBlock>();

      // Reads concurrently (bounded).
      if (reads.length > 0) {
        const queue = reads.slice();
        const workers: Promise<void>[] = [];
        const limit = Math.min(readConcurrency, queue.length);
        for (let i = 0; i < limit; i++) {
          workers.push((async (): Promise<void> => {
            while (true) {
              const call = queue.shift();
              if (!call) return;
              const block = await runOne(call, opts.registry, ctx);
              results.set(call.toolUseId, block);
            }
          })());
        }
        await Promise.all(workers);
      }

      // Writes sequentially.
      for (const call of writes) {
        const block = await runOne(call, opts.registry, ctx);
        results.set(call.toolUseId, block);
      }

      // Preserve original order.
      return calls.map((c) => results.get(c.toolUseId)!).filter(Boolean);
    },
  };
}

async function runOne(
  call: ToolCall,
  registry: ToolRegistry,
  ctx: ExecutorRunContext,
): Promise<ToolResultBlock> {
  const tool = registry.get(call.name);
  if (!tool) {
    return errorBlock(call.toolUseId, new NimbusError(ErrorCode.T_NOT_FOUND, {
      reason: 'unknown_tool',
      name: call.name,
    }));
  }

  // Zod validation.
  const parsed = tool.inputSchema.safeParse(call.input);
  if (!parsed.success) {
    const zErr = parsed.error as z.ZodError;
    return errorBlock(call.toolUseId, new NimbusError(ErrorCode.T_VALIDATION, {
      tool: call.name,
      issues: zErr.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }));
  }

  // Permission gate (before handler; no side effects).
  try {
    const decision = await ctx.permissions.canUseTool(
      { name: tool.name, input: (parsed.data ?? {}) as Record<string, unknown> },
      {
        sessionId: ctx.sessionId,
        workspaceId: ctx.workspaceId,
        mode: ctx.mode,
        cwd: ctx.cwd,
      },
    );
    if (decision === 'deny') {
      return errorBlock(call.toolUseId, new NimbusError(ErrorCode.T_PERMISSION, {
        tool: tool.name,
        reason: 'gate_deny',
      }));
    }
    if (decision === 'ask') {
      // Executor treats 'ask' as deny at this layer — channel must pre-confirm
      // via gate.rememberAllow before running. v0.1 keeps interaction out of
      // the executor so REPL can manage UX.
      return errorBlock(call.toolUseId, new NimbusError(ErrorCode.T_PERMISSION, {
        tool: tool.name,
        reason: 'needs_confirm',
      }));
    }
  } catch (err) {
    const nerr = err instanceof NimbusError
      ? err
      : new NimbusError(classify(err), { tool: call.name }, err as Error);
    return errorBlock(call.toolUseId, nerr);
  }

  // Build per-call context + cancellation scope.
  const scope = createCancellationScope(ctx.parentSignal);
  const toolCtx: ToolContext = {
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    toolUseId: call.toolUseId,
    cwd: ctx.cwd,
    signal: scope.signal,
    onAbort: scope.onAbort,
    permissions: ctx.permissions,
    mode: ctx.mode,
    logger: rootLogger.child({ tool: tool.name, toolUseId: call.toolUseId }),
  };

  try {
    const result = await invokeHandler(tool, parsed.data, toolCtx);
    return resultToBlock(call.toolUseId, result);
  } catch (err) {
    const nerr = err instanceof NimbusError
      ? err
      : new NimbusError(classify(err) === ErrorCode.T_CRASH ? ErrorCode.T_CRASH : classify(err), {
          tool: call.name,
          reason: 'handler_threw',
        }, err instanceof Error ? err : undefined);
    return errorBlock(call.toolUseId, nerr);
  } finally {
    scope.dispose();
  }
}

async function invokeHandler<I, O>(
  tool: Tool<I, O>,
  input: I,
  ctx: ToolContext,
): Promise<ToolResult<O>> {
  return await tool.handler(input, ctx);
}

function resultToBlock<O>(toolUseId: string, res: ToolResult<O>): ToolResultBlock {
  if (res.ok) {
    const text = res.display ?? formatOutput(res.output);
    const block: Extract<CanonicalBlock, { type: 'tool_result' }> = {
      type: 'tool_result',
      toolUseId,
      content: text,
      isError: false,
    };
    return { toolUseId, block };
  }
  return errorBlock(toolUseId, res.error, res.display);
}

function errorBlock(toolUseId: string, err: NimbusError, display?: string): ToolResultBlock {
  const text = display ?? `${err.code}: ${safeStringify(err.context)}`;
  return {
    toolUseId,
    block: { type: 'tool_result', toolUseId, content: text, isError: true },
  };
}

function formatOutput(o: unknown): string {
  if (typeof o === 'string') return o;
  try { return JSON.stringify(o); } catch { return String(o); }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
