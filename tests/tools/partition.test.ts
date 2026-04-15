// tests/tools/partition.test.ts — SPEC-301 T3.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRegistry } from '../../src/tools/registry.ts';
import { partitionToolCalls } from '../../src/tools/partition.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { Tool } from '../../src/tools/types.ts';

function tool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: name,
    readOnly,
    inputSchema: z.object({}).strict(),
    async handler() { return { ok: true as const, output: {} }; },
  };
}

describe('SPEC-301: partitionToolCalls', () => {
  test('splits reads and writes preserving order', () => {
    const r = createRegistry();
    r.register(tool('ReadA', true));
    r.register(tool('WriteB', false));
    r.register(tool('ReadC', true));
    r.register(tool('WriteD', false));
    const calls = [
      { toolUseId: '1', name: 'ReadA', input: {} },
      { toolUseId: '2', name: 'WriteB', input: {} },
      { toolUseId: '3', name: 'ReadC', input: {} },
      { toolUseId: '4', name: 'WriteD', input: {} },
    ];
    const { reads, writes } = partitionToolCalls(calls, r);
    expect(reads.map((c) => c.toolUseId)).toEqual(['1', '3']);
    expect(writes.map((c) => c.toolUseId)).toEqual(['2', '4']);
  });

  test('unknown tool → T_NOT_FOUND', () => {
    const r = createRegistry();
    try {
      partitionToolCalls([{ toolUseId: 'x', name: 'Ghost', input: {} }], r);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_NOT_FOUND);
    }
  });
});
