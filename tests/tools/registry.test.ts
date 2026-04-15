// tests/tools/registry.test.ts — SPEC-301 T2: registry unit tests.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRegistry } from '../../src/tools/registry.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { Tool } from '../../src/tools/types.ts';

function mkTool(name: string, readOnly = true): Tool {
  return {
    name,
    description: `test tool ${name}`,
    readOnly,
    inputSchema: z.object({ x: z.string() }).strict(),
    async handler(input) {
      return { ok: true as const, output: input };
    },
  };
}

describe('SPEC-301: tool registry', () => {
  test('register + get round-trip', () => {
    const r = createRegistry();
    r.register(mkTool('Alpha'));
    expect(r.get('Alpha')?.name).toBe('Alpha');
    expect(r.list().length).toBe(1);
  });

  test('duplicate registration throws T_VALIDATION', () => {
    const r = createRegistry();
    r.register(mkTool('A'));
    try {
      r.register(mkTool('A'));
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    }
  });

  test('toJsonSchemas returns one entry per tool with JSON schema shape', () => {
    const r = createRegistry();
    r.register(mkTool('A'));
    r.register(mkTool('B', false));
    const schemas = r.toJsonSchemas();
    expect(schemas.length).toBe(2);
    for (const s of schemas) {
      expect(typeof s.name).toBe('string');
      expect(s.inputSchema['type']).toBe('object');
    }
  });
});
