// BashOutput.ts — SPEC-308 T4: poll incremental output from a background shell task.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { getShellTaskRegistry } from '../../core/shellTaskRegistry.ts';
import type { Tool } from '../types.ts';

export const BashOutputInputSchema = z.object({
  taskId: z.string().uuid(),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
}).strict();
export type BashOutputInput = z.infer<typeof BashOutputInputSchema>;

export interface BashOutputResult {
  taskId: string;
  status: 'running' | 'exited' | 'killed' | 'timed_out';
  exitCode: number | null;
  lines: string[];
  nextSince: number;
}

export function createBashOutputTool(): Tool<BashOutputInput, BashOutputResult> {
  return {
    name: 'BashOutput',
    description:
      'Retrieve incremental stdout+stderr lines from a background shell task. ' +
      'Pass `since` to fetch only new lines since that index (default: 0). ' +
      'Returns `nextSince` to use on the next call for cursor-based polling.',
    readOnly: true,
    dangerous: false,
    inputSchema: BashOutputInputSchema,
    async handler(input, _ctx) {
      const registry = getShellTaskRegistry();
      const task = registry.getTask(input.taskId);
      if (!task) {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.U_MISSING_CONFIG, { taskId: input.taskId }),
        };
      }

      // Interleave stdout/stderr in order by index (simple: stdout then stderr sliced).
      // Spec says "stdout+stderr lines since index since" — we concatenate both buffers.
      const allLines = [...task.stdout, ...task.stderr];
      const since = input.since ?? 0;
      const limit = input.limit;
      let slice = allLines.slice(since);
      if (limit !== undefined) slice = slice.slice(0, limit);

      const nextSince = since + slice.length;

      return {
        ok: true,
        output: {
          taskId: task.id,
          status: task.status,
          exitCode: task.exitCode,
          lines: slice,
          nextSince,
        },
        display: `taskId=${task.id} status=${task.status} lines=${slice.length} nextSince=${nextSince}`,
      };
    },
  };
}
