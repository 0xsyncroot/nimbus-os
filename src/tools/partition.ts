// partition.ts — SPEC-301: split tool calls into reads (parallel) and writes (serial).

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { ToolCall } from './types.ts';
import type { ToolRegistry } from './registry.ts';

export function partitionToolCalls(
  calls: ToolCall[],
  registry: ToolRegistry,
): { reads: ToolCall[]; writes: ToolCall[] } {
  const reads: ToolCall[] = [];
  const writes: ToolCall[] = [];
  for (const c of calls) {
    const tool = registry.get(c.name);
    if (!tool) {
      throw new NimbusError(ErrorCode.T_NOT_FOUND, {
        reason: 'unknown_tool',
        name: c.name,
      });
    }
    if (tool.readOnly) reads.push(c);
    else writes.push(c);
  }
  return { reads, writes };
}
