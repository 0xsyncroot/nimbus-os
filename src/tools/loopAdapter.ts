// loopAdapter.ts — bridges tools registry+executor to core/loop.ts ToolExecutor interface.

import type { Gate } from '../permissions/gate.ts';
import type {
  ToolExecutor as LoopToolExecutor,
  ToolInvocation as LoopToolInvocation,
  ToolResult as LoopToolResult,
} from '../core/loop.ts';
import type { ToolDefinition } from '../ir/types.ts';
import type { ToolRegistry } from './registry.ts';
import { createExecutor } from './executor.ts';

export interface LoopAdapterOptions {
  registry: ToolRegistry;
  permissions: Gate;
  workspaceId: string;
  sessionId: string;
  cwd: string;
  mode: 'default' | 'readonly' | 'bypass';
  readConcurrency?: number;
}

export function createLoopAdapter(opts: LoopAdapterOptions): LoopToolExecutor {
  const executor = createExecutor({
    registry: opts.registry,
    ...(opts.readConcurrency !== undefined ? { readConcurrency: opts.readConcurrency } : {}),
  });

  return {
    listTools(): ToolDefinition[] {
      return opts.registry.toJsonSchemas();
    },
    effectOf(name: string): 'pure' | 'read' | 'write' | 'exec' {
      const tool = opts.registry.get(name);
      if (!tool) return 'exec';
      if (tool.readOnly) return 'read';
      if (name === 'Bash') return 'exec';
      return 'write';
    },
    async execute(inv: LoopToolInvocation, signal: AbortSignal): Promise<LoopToolResult> {
      const turnId = inv.toolUseId;
      const [block] = await executor.run([
        { toolUseId: inv.toolUseId, name: inv.name, input: inv.input },
      ], {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId,
        turnId,
        cwd: opts.cwd,
        mode: opts.mode,
        permissions: opts.permissions,
        parentSignal: signal,
      });
      const tool = opts.registry.get(inv.name);
      const effect: 'pure' | 'read' | 'write' | 'exec' = tool
        ? (tool.readOnly ? 'read' : (inv.name === 'Bash' ? 'exec' : 'write'))
        : 'exec';
      if (!block) {
        return {
          toolUseId: inv.toolUseId,
          ok: false,
          content: 'tool execution produced no result',
          sideEffects: effect,
        };
      }
      return {
        toolUseId: inv.toolUseId,
        ok: !(block.block.isError ?? false),
        content: block.block.content,
        sideEffects: effect,
      };
    },
  };
}
