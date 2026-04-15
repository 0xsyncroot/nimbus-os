// tests/tools/executor.test.ts — SPEC-301 T4 executor tests.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRegistry } from '../../src/tools/registry.ts';
import { createExecutor } from '../../src/tools/executor.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import type { Tool } from '../../src/tools/types.ts';
import type { Gate } from '../../src/permissions/gate.ts';

function allowGate(): Gate {
  return {
    async canUseTool() { return 'allow' as const; },
    rememberAllow() { /* noop */ },
    forgetSession() { /* noop */ },
  };
}

function denyGate(): Gate {
  return {
    async canUseTool() { return 'deny' as const; },
    rememberAllow() { /* noop */ },
    forgetSession() { /* noop */ },
  };
}

function echoTool(name: string, readOnly: boolean, delayMs = 0): Tool {
  return {
    name,
    description: name,
    readOnly,
    inputSchema: z.object({ x: z.string() }).strict(),
    async handler(input) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true as const, output: input, display: `ok:${(input as { x: string }).x}` };
    },
  };
}

const baseCtx = {
  workspaceId: 'W1',
  sessionId: '01HVW3CTEST0000000000000000',
  turnId: 'T1',
  cwd: '/tmp',
  mode: 'default' as const,
  parentSignal: new AbortController().signal,
};

describe('SPEC-301: executor', () => {
  test('parallel reads start concurrently', async () => {
    const r = createRegistry();
    for (let i = 0; i < 5; i++) r.register(echoTool(`R${i}`, true, 50));
    const ex = createExecutor({ registry: r, readConcurrency: 10 });
    const calls = Array.from({ length: 5 }, (_, i) => ({ toolUseId: `${i}`, name: `R${i}`, input: { x: String(i) } }));
    const start = Date.now();
    const results = await ex.run(calls, { ...baseCtx, permissions: allowGate() });
    const elapsed = Date.now() - start;
    expect(results.length).toBe(5);
    expect(elapsed).toBeLessThan(200); // would be 250 if serial
  });

  test('writes run serially', async () => {
    const r = createRegistry();
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      r.register({
        name: `W${i}`,
        description: `W${i}`,
        readOnly: false,
        inputSchema: z.object({}).strict(),
        async handler() {
          times.push(Date.now());
          await new Promise((res) => setTimeout(res, 30));
          return { ok: true as const, output: {} };
        },
      });
    }
    const ex = createExecutor({ registry: r });
    const calls = [
      { toolUseId: '1', name: 'W0', input: {} },
      { toolUseId: '2', name: 'W1', input: {} },
      { toolUseId: '3', name: 'W2', input: {} },
    ];
    await ex.run(calls, { ...baseCtx, permissions: allowGate() });
    expect(times.length).toBe(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(25);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(25);
  });

  test('zod validation failure — isError tool_result', async () => {
    const r = createRegistry();
    r.register(echoTool('R', true));
    const ex = createExecutor({ registry: r });
    const [result] = await ex.run(
      [{ toolUseId: '1', name: 'R', input: { wrong: true } }],
      { ...baseCtx, permissions: allowGate() },
    );
    expect(result!.block.isError).toBe(true);
    expect(String(result!.block.content)).toContain('T_VALIDATION');
  });

  test('handler throws raw → wrapped error block', async () => {
    const r = createRegistry();
    r.register({
      name: 'Boom',
      description: 'x',
      readOnly: true,
      inputSchema: z.object({}).strict(),
      async handler() { throw new Error('oops'); },
    });
    const ex = createExecutor({ registry: r });
    const [res] = await ex.run(
      [{ toolUseId: '1', name: 'Boom', input: {} }],
      { ...baseCtx, permissions: allowGate() },
    );
    expect(res!.block.isError).toBe(true);
  });

  test('gate deny → T_PERMISSION block', async () => {
    const r = createRegistry();
    r.register(echoTool('R', true));
    const ex = createExecutor({ registry: r });
    const [res] = await ex.run(
      [{ toolUseId: '1', name: 'R', input: { x: 'a' } }],
      { ...baseCtx, permissions: denyGate() },
    );
    expect(res!.block.isError).toBe(true);
    expect(String(res!.block.content)).toContain('T_PERMISSION');
  });

  test('unknown tool → T_NOT_FOUND (via partition)', async () => {
    const r = createRegistry();
    const ex = createExecutor({ registry: r });
    try {
      await ex.run([{ toolUseId: '1', name: 'Ghost', input: {} }], { ...baseCtx, permissions: allowGate() });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_NOT_FOUND);
    }
  });
});
