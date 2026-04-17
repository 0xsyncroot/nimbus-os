// loopAdapterHost.test.ts — SPEC-832: tests for host?: UIHost in loopAdapter.
//
// Covers:
// - Loop with host invokes host.ask on needs_confirm
// - Loop falls back to onAsk when no host provided
// - host.canAsk()===false returns deny without prompting

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
import type { UIHost, UIContext, UIIntent, UIResult } from '../../src/core/ui/index.ts';
import type { Tool } from '../../src/tools/types.ts';

const origNimbusHome = process.env['NIMBUS_HOME'];
let tmpHome: string;
const noopAudit = async (): Promise<void> => { /* noop */ };

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-loopadapter-host-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
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

/** Build a UIHost that returns a fixed decision. */
function makeHost(decision: 'allow' | 'deny' | 'always' | 'cancel', canAsk: boolean = true): UIHost & { canAsk(): boolean; askCalls: UIIntent[] } {
  const askCalls: UIIntent[] = [];
  return {
    askCalls,
    canAsk(): boolean { return canAsk; },
    async ask<T>(intent: UIIntent, _ctx: UIContext): Promise<UIResult<T>> {
      askCalls.push(intent);
      if (decision === 'cancel') return { kind: 'cancel' } as UIResult<T>;
      return { kind: 'ok', value: decision as unknown as T };
    },
  };
}

describe('SPEC-832: loopAdapter host wiring', () => {
  test('host.ask() is called when needs_confirm fires and host.canAsk()===true', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    const host = makeHost('allow');

    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W1',
      sessionId: 'S1',
      cwd: '/tmp/project',
      mode: 'default',
      host,
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_h1', name: 'Write', input: { path: '/tmp/project/b.ts', content: 'ok' } },
      signal,
    );

    // tool should succeed after host.ask() returned 'allow'
    expect(res.ok).toBe(true);
    // host.ask was called at least once for the confirm intent
    expect(host.askCalls.length).toBeGreaterThan(0);
    expect(host.askCalls[0]?.kind).toBe('confirm');
  });

  test('host.canAsk()===false falls back to onAsk', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    // host that cannot ask
    const host = makeHost('allow', /* canAsk */ false);
    const onAskCalls: string[] = [];

    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W2',
      sessionId: 'S2',
      cwd: '/tmp/project',
      mode: 'default',
      host,
      onAsk: async (inv) => {
        onAskCalls.push(inv.name);
        return 'allow';
      },
    });

    const signal = new AbortController().signal;
    await adapter.execute(
      { toolUseId: 'call_h2', name: 'Write', input: { path: '/tmp/project/c.ts', content: 'ok' } },
      signal,
    );

    // host.ask should NOT have been called
    expect(host.askCalls.length).toBe(0);
    // onAsk WAS called as fallback
    expect(onAskCalls).toContain('Write');
  });

  test('host returns cancel → tool returns user_denied', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });

    const host = makeHost('cancel');

    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W3',
      sessionId: 'S3',
      cwd: '/tmp/project',
      mode: 'default',
      host,
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_h3', name: 'Write', input: { path: '/tmp/project/d.ts', content: 'ok' } },
      signal,
    );

    // cancel maps to 'deny' → user_denied result
    expect(res.ok).toBe(false);
    expect(res.content).toContain('user_denied');
  });

  test('no host → falls back to onAsk (original SPEC-825 behaviour)', async () => {
    const reg = createRegistry();
    reg.register(writeTool());
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    const onAskCalls: string[] = [];

    const adapter = createLoopAdapter({
      registry: reg,
      permissions: gate,
      workspaceId: 'W4',
      sessionId: 'S4',
      cwd: '/tmp/project',
      mode: 'default',
      onAsk: async (inv) => {
        onAskCalls.push(inv.name);
        return 'allow';
      },
    });

    const signal = new AbortController().signal;
    const res = await adapter.execute(
      { toolUseId: 'call_h4', name: 'Write', input: { path: '/tmp/project/e.ts', content: 'ok' } },
      signal,
    );

    expect(res.ok).toBe(true);
    expect(onAskCalls).toContain('Write');
  });
});
