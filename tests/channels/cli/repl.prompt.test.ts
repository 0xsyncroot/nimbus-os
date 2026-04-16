// tests/channels/cli/repl.prompt.test.ts — SPEC-825 T5: onAsk confirm flow unit tests.
// Tests loopAdapter onAsk wiring in isolation (no full REPL boot required).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRegistry } from '../../../src/tools/registry.ts';
import { createLoopAdapter } from '../../../src/tools/loopAdapter.ts';
import type { Gate } from '../../../src/permissions/gate.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';

// A gate that always returns 'ask' for all tools.
function askGate(): Gate {
  return {
    async canUseTool() { return 'ask' as const; },
    rememberAllow(_sessionId: string, _key: string) { /* noop */ },
    forgetSession(_sessionId: string) { /* noop */ },
  };
}

// A gate that tracks rememberAllow calls then returns 'allow'.
function trackingGate(): Gate & { allowed: string[] } {
  const allowed: string[] = [];
  let callCount = 0;
  return {
    allowed,
    async canUseTool() {
      callCount += 1;
      // First call: ask. Subsequent calls: allow (simulates rememberAllow effect).
      return callCount === 1 ? 'ask' : 'allow';
    },
    rememberAllow(_sessionId: string, key: string) {
      allowed.push(key);
    },
    forgetSession(_sessionId: string) { /* noop */ },
  };
}

function writeTool() {
  return {
    name: 'Write',
    description: 'write a file',
    readOnly: false,
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    async handler(_input: { path: string; content: string }) {
      return { ok: true as const, output: { written: true }, display: 'ok' };
    },
  };
}

const baseAdapterOpts = {
  workspaceId: 'W1',
  sessionId: 'S1',
  cwd: '/tmp',
  mode: 'default' as const,
};

const signal = new AbortController().signal;

describe('SPEC-825: loopAdapter — onAsk deny returns T_PERMISSION:user_denied', () => {
  test('deny → tool_result isError with user_denied reason', async () => {
    const r = createRegistry();
    r.register(writeTool());

    const adapter = createLoopAdapter({
      ...baseAdapterOpts,
      registry: r,
      permissions: askGate(),
      onAsk: async () => 'deny',
    });

    const result = await adapter.execute(
      { toolUseId: 'tu-1', name: 'Write', input: { path: '/tmp/test.txt', content: 'hi' } },
      signal,
    );
    expect(result.ok).toBe(false);
    const content = typeof result.content === 'string' ? result.content : '';
    expect(content).toContain(ErrorCode.T_PERMISSION);
    expect(content).toContain('user_denied');
  });
});

describe('SPEC-825: loopAdapter — onAsk allow re-executes tool once', () => {
  test('allow → tool runs and result is ok', async () => {
    const r = createRegistry();
    r.register(writeTool());

    // Gate asks on first call, then allows (simulates rememberAllow taking effect).
    const gate = trackingGate();

    const adapter = createLoopAdapter({
      ...baseAdapterOpts,
      registry: r,
      permissions: gate,
      onAsk: async () => 'allow',
    });

    const result = await adapter.execute(
      { toolUseId: 'tu-2', name: 'Write', input: { path: '/tmp/x.ts', content: 'hi' } },
      signal,
    );
    // After 'allow' decision, adapter re-runs; gate now returns 'allow' on 2nd call.
    expect(result.ok).toBe(true);
  });
});

describe('SPEC-825: loopAdapter — onAsk always calls rememberAllow then re-executes', () => {
  test('always → rememberAllow called + tool runs ok', async () => {
    const r = createRegistry();
    r.register(writeTool());

    const gate = trackingGate();

    const adapter = createLoopAdapter({
      ...baseAdapterOpts,
      registry: r,
      permissions: gate,
      onAsk: async () => 'always',
    });

    const result = await adapter.execute(
      { toolUseId: 'tu-3', name: 'Write', input: { path: '/tmp/y.ts', content: 'hello' } },
      signal,
    );
    // rememberAllow should have been called with a key
    expect(gate.allowed.length).toBeGreaterThan(0);
    const key = gate.allowed[0]!;
    expect(key).toContain('Write');
    expect(result.ok).toBe(true);
  });
});

describe('SPEC-825: loopAdapter — no onAsk (non-interactive) returns needs_confirm error', () => {
  test('no onAsk → needs_confirm error passthrough', async () => {
    const r = createRegistry();
    r.register(writeTool());

    const adapter = createLoopAdapter({
      ...baseAdapterOpts,
      registry: r,
      permissions: askGate(),
      // no onAsk
    });

    const result = await adapter.execute(
      { toolUseId: 'tu-4', name: 'Write', input: { path: '/tmp/z.ts', content: 'x' } },
      signal,
    );
    expect(result.ok).toBe(false);
    const content = typeof result.content === 'string' ? result.content : '';
    expect(content).toContain(ErrorCode.T_PERMISSION);
    expect(content).toContain('needs_confirm');
  });
});
