// tests/tools/loopAdapter.test.ts — SPEC-825 + v0.3.4 Bug B regression.
//
// Covers the onAsk → rememberAllow → re-run contract end-to-end through the
// actual gate. The v0.3.3 bug was that `allow` (one-shot) did not populate
// the gate cache, and the destructive-tool fallback in decideByMode did not
// consult the cache even when `always` did populate it — so the second
// runOnce still returned `needs_confirm` and the user saw a generic
// "Tool failed" error.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createRegistry } from '../../src/tools/registry.ts';
import { createLoopAdapter } from '../../src/tools/loopAdapter.ts';
import { __resetPathValidatorCache } from '../../src/permissions/pathValidator.ts';
import { createGate } from '../../src/permissions/gate.ts';
import { compileRules } from '../../src/permissions/rule.ts';
import type { Tool } from '../../src/tools/types.ts';

const origNimbusHome = process.env['NIMBUS_HOME'];
let tmpHome: string;
const noopAudit = async () => { /* noop */ };

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-loopadapter-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {/* noop */ }
  __resetPathValidatorCache();
});

function writeTool(): Tool {
  return {
    name: 'Write',
    description: 'write',
    readOnly: false,
    inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
    async handler(input) {
      return {
        ok: true as const,
        output: input,
        display: `wrote ${(input as { path: string }).path}`,
      };
    },
  };
}

describe('SPEC-825 + v0.3.4 Bug B: loopAdapter onAsk flow', () => {
  test('allow → tool actually re-executes successfully', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    const askCalls: string[] = [];
    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W1',
      sessionId: 'S1',
      cwd: '/tmp/project',
      mode: 'default',
      onAsk: async (inv) => {
        askCalls.push(inv.name);
        return 'allow';
      },
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_1', name: 'Write', input: { path: '/tmp/project/a.ts', content: 'hi' } },
      signal,
    );

    expect(askCalls).toEqual(['Write']);
    // Bug B regression: used to stay in `needs_confirm` → user saw generic
    // "Tool failed". Now the re-run passes the gate and handler runs.
    expect(res.ok).toBe(true);
    expect(String(res.content)).toContain('wrote /tmp/project/a.ts');
  });

  test('always → remembered for the rest of the session', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    let asks = 0;
    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W1',
      sessionId: 'S1',
      cwd: '/tmp/project',
      mode: 'default',
      onAsk: async () => {
        asks++;
        return 'always';
      },
    });

    const signal = new AbortController().signal;
    const res1 = await adapter.execute(
      { toolUseId: 'call_1', name: 'Write', input: { path: '/tmp/project/a.ts', content: 'hi' } },
      signal,
    );
    const res2 = await adapter.execute(
      { toolUseId: 'call_2', name: 'Write', input: { path: '/tmp/project/a.ts', content: 'bye' } },
      signal,
    );

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    // Second invocation with the same name:target key must NOT prompt again.
    expect(asks).toBe(1);
  });

  test('deny → synthesized T_PERMISSION:user_denied, no re-execute', async () => {
    const reg = createRegistry();
    let handlerCalls = 0;
    reg.register({
      ...writeTool(),
      async handler() {
        handlerCalls++;
        return { ok: true as const, output: {}, display: 'should not run' };
      },
    });
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W1',
      sessionId: 'S1',
      cwd: '/tmp/project',
      mode: 'default',
      onAsk: async () => 'deny',
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_1', name: 'Write', input: { path: '/tmp/project/a.ts', content: 'hi' } },
      signal,
    );

    expect(res.ok).toBe(false);
    expect(String(res.content)).toContain('T_PERMISSION');
    expect(String(res.content)).toContain('user_denied');
    expect(handlerCalls).toBe(0);
  });

  // REGRESSION v0.3.19: user pressed "Yes" on TelegramStatus confirm but the
  // tool was still denied. Root cause: loopAdapter.askRuleKey falls back to
  // `name` when extractMatchTarget returns null (no path/cmd/url/query input),
  // but gate.askCacheKey returns null in that case → cache lookup always
  // misses → second runOnce re-hits 'ask' → loopAdapter returns needs_confirm
  // → user sees "You denied this action.". Affected: all tools with no
  // path/cmd/url/query input (TelegramStatus, ConnectTelegram, TodoWrite,
  // ExitPlanMode, etc.). Must use the SAME key-derivation on both sides.
  test('allow → no-target tool (no path/cmd/url) still re-executes successfully', async () => {
    const reg = createRegistry();
    let handlerCalls = 0;
    reg.register({
      name: 'TelegramStatus',
      description: 'report telegram status',
      readOnly: true,
      inputSchema: z.object({}).strict(),
      async handler() {
        handlerCalls++;
        return { ok: true as const, output: { connected: false }, display: 'ok' };
      },
    });
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    const askCalls: string[] = [];
    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W1',
      sessionId: 'S1',
      cwd: '/tmp/project',
      mode: 'default',
      onAsk: async (inv) => {
        askCalls.push(inv.name);
        return 'allow';
      },
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_1', name: 'TelegramStatus', input: {} },
      signal,
    );

    // onAsk MUST have been consulted exactly once.
    expect(askCalls).toEqual(['TelegramStatus']);
    // After 'allow', handler MUST have run and tool MUST have succeeded.
    expect(handlerCalls).toBe(1);
    expect(res.ok).toBe(true);
  });
});
