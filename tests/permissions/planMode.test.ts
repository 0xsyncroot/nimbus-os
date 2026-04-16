// tests/permissions/planMode.test.ts — SPEC-133 §6.1 plan mode gate tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import { __resetPathValidatorCache } from '../../src/permissions/pathValidator.ts';
import { compileRules } from '../../src/permissions/rule.ts';
import { createGate } from '../../src/permissions/gate.ts';
import {
  isAllowedInPlanMode,
  PLAN_MODE_ALLOWED_TOOLS,
  assertImplemented,
  isValidTransition,
} from '../../src/permissions/mode.ts';
import { __resetGlobalBus, createEventBus } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import type { PermissionContext, ToolInvocation } from '../../src/permissions/index.ts';

let tmpHome: string;
const origNimbusHome = process.env['NIMBUS_HOME'];
const noopAudit = async () => { /* noop */ };

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-plan-mode-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
  __resetGlobalBus();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
  __resetGlobalBus();
});

function ctx(mode: PermissionContext['mode']): PermissionContext {
  return { sessionId: 'S1', workspaceId: 'W1', mode, cwd: '/tmp/project' };
}

function inv(name: string, input: Record<string, unknown> = {}): ToolInvocation {
  return { name, input };
}

// ─── isAllowedInPlanMode unit tests ──────────────────────────────────────────

describe('SPEC-133: isAllowedInPlanMode — whitelist', () => {
  test('returns true for all whitelisted tools', () => {
    for (const tool of PLAN_MODE_ALLOWED_TOOLS) {
      expect(isAllowedInPlanMode(tool)).toBe(true);
    }
  });

  test('returns true for Read', () => {
    expect(isAllowedInPlanMode('Read')).toBe(true);
  });

  test('returns true for Grep', () => {
    expect(isAllowedInPlanMode('Grep')).toBe(true);
  });

  test('returns true for Glob', () => {
    expect(isAllowedInPlanMode('Glob')).toBe(true);
  });

  test('returns true for TodoWrite', () => {
    expect(isAllowedInPlanMode('TodoWrite')).toBe(true);
  });

  test('returns true for ExitPlanMode', () => {
    expect(isAllowedInPlanMode('ExitPlanMode')).toBe(true);
  });

  test('returns true for EnterPlanMode', () => {
    expect(isAllowedInPlanMode('EnterPlanMode')).toBe(true);
  });

  test('returns false for Bash', () => {
    expect(isAllowedInPlanMode('Bash')).toBe(false);
  });

  test('returns false for Write', () => {
    expect(isAllowedInPlanMode('Write')).toBe(false);
  });

  test('returns false for Edit', () => {
    expect(isAllowedInPlanMode('Edit')).toBe(false);
  });

  test('returns false for unknown tool', () => {
    expect(isAllowedInPlanMode('MysteryTool')).toBe(false);
  });
});

// ─── Mode transition tests ───────────────────────────────────────────────────

describe('SPEC-133: mode transitions involving plan', () => {
  test('assertImplemented does not throw for plan mode', () => {
    expect(() => assertImplemented('plan')).not.toThrow();
  });

  test('isValidTransition default → plan', () => {
    expect(isValidTransition('default', 'plan')).toBe(true);
  });

  test('isValidTransition plan → default', () => {
    expect(isValidTransition('plan', 'default')).toBe(true);
  });

  test('isValidTransition plan → plan (idempotent)', () => {
    expect(isValidTransition('plan', 'plan')).toBe(true);
  });

  test('isValidTransition isolated → isolated throws not-implemented', () => {
    // isolated is still not implemented
    expect(isValidTransition('default', 'isolated')).toBe(false);
  });
});

// ─── Gate plan mode tests ────────────────────────────────────────────────────

describe('SPEC-133: gate — plan mode whitelist', () => {
  test('allows Read in plan mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }), ctx('plan'))).toBe('allow');
  });

  test('allows Grep in plan mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Grep', { pattern: 'foo' }), ctx('plan'))).toBe('allow');
  });

  test('allows Glob in plan mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Glob', { pattern: '**/*.ts' }), ctx('plan'))).toBe('allow');
  });

  test('allows TodoWrite in plan mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('TodoWrite', {}), ctx('plan'))).toBe('allow');
  });

  test('allows ExitPlanMode in plan mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('ExitPlanMode', { plan: 'do stuff' }), ctx('plan'))).toBe('allow');
  });

  test('blocks Bash in plan mode → T_PERMISSION + hint', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('Bash', { command: 'echo hi' }), ctx('plan'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      const ne = err as NimbusError;
      expect(ne.code).toBe(ErrorCode.T_PERMISSION);
      expect(ne.context['reason']).toBe('plan_mode_whitelist');
      expect(ne.context['hint']).toBe('Exit plan mode first');
    }
  });

  test('blocks Write in plan mode → T_PERMISSION', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }), ctx('plan'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('blocks Edit in plan mode → T_PERMISSION', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('Edit', { path: '/tmp/project/a.ts' }), ctx('plan'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('blocks unknown tool in plan mode → T_PERMISSION', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('SomeRandomTool', {}), ctx('plan'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });
});

// ─── Security event emission ─────────────────────────────────────────────────

describe('SPEC-133: gate plan mode — security event emission', () => {
  test('Bash in plan mode emits security.event', async () => {
    // Set up fresh bus so we can subscribe before the gate fires.
    __resetGlobalBus();
    const { getGlobalBus } = await import('../../src/core/events.ts');
    const bus = getGlobalBus();

    const securityEvents: unknown[] = [];
    bus.subscribe(TOPICS.security.event, (e) => {
      securityEvents.push(e);
    });

    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('Bash', { command: 'rm -rf /' }), ctx('plan'));
    } catch {
      // expected T_PERMISSION
    }

    // Allow microtask queue to drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(securityEvents.length).toBeGreaterThanOrEqual(1);
    const ev = securityEvents[0] as { type: string; reason: string };
    expect(ev.type).toBe(TOPICS.security.event);
    expect(ev.reason).toContain('plan_mode_blocked:Bash');
  });

  test('Write in plan mode emits security.event', async () => {
    __resetGlobalBus();
    const { getGlobalBus } = await import('../../src/core/events.ts');
    const bus = getGlobalBus();

    const events: unknown[] = [];
    bus.subscribe(TOPICS.security.event, (e) => { events.push(e); });

    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    try {
      await gate.canUseTool(inv('Write', { path: '/tmp/evil.ts' }), ctx('plan'));
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
