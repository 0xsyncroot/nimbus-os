// tests/permissions/gate.test.ts — SPEC-401 §6.1 gate tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import { __resetPathValidatorCache } from '../../src/permissions/pathValidator.ts';
import { compileRules, parseRule } from '../../src/permissions/rule.ts';
import { createGate } from '../../src/permissions/gate.ts';
import type { PermissionContext, PermissionMode, ToolInvocation } from '../../src/permissions/index.ts';

const origNimbusHome = process.env['NIMBUS_HOME'];
let tmpHome: string;
const noopAudit = async () => { /* noop */ };

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-gate-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {/* noop */}
  __resetPathValidatorCache();
});

function ctx(mode: PermissionMode): PermissionContext {
  return { sessionId: 'S1', workspaceId: 'W1', mode, cwd: '/tmp/project' };
}

function inv(name: string, input: Record<string, unknown>): ToolInvocation {
  return { name, input };
}

describe('SPEC-401: gate — readonly mode', () => {
  test('allows Read/Grep/Glob', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }), ctx('readonly'))).toBe('allow');
    expect(await gate.canUseTool(inv('Grep', { path: '/tmp/project' }), ctx('readonly'))).toBe('allow');
    expect(await gate.canUseTool(inv('Glob', { path: '/tmp/project' }), ctx('readonly'))).toBe('allow');
  });

  test('denies Write/Edit/Bash', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }), ctx('readonly'))).toBe('deny');
    expect(await gate.canUseTool(inv('Edit', { path: '/tmp/project/a.ts' }), ctx('readonly'))).toBe('deny');
    expect(await gate.canUseTool(inv('Bash', { cmd: 'echo x' }), ctx('readonly'))).toBe('deny');
  });

  test('denies unknown tool fail-closed', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('MysteryTool', {}), ctx('readonly'))).toBe('deny');
  });
});

describe('SPEC-401: gate — default mode', () => {
  test('matching allow rule → allow', async () => {
    const rules = compileRules([parseRule('Bash(git:*)', 'allow', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    expect(await gate.canUseTool(inv('Bash', { cmd: 'git:commit' }), ctx('default'))).toBe('allow');
  });

  test('matching deny rule → deny', async () => {
    const rules = compileRules([parseRule('Bash(rm:*)', 'deny', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx('default'))).toBe('deny');
  });

  test('no rule match for destructive tool → ask', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Bash', { cmd: 'ls' }), ctx('default'))).toBe('ask');
  });

  test('no rule match for read tool → allow', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }), ctx('default'))).toBe('allow');
  });

  test('unknown tool → ask', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    expect(await gate.canUseTool(inv('SomeMcpTool', {}), ctx('default'))).toBe('ask');
  });

  test('ask cache: rememberAllow converts ask → allow on next call', async () => {
    const rules = compileRules([parseRule('Bash(rm:*)', 'ask', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx('default'))).toBe('ask');
    gate.rememberAllow('S1', 'Bash:rm:foo');
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx('default'))).toBe('allow');
  });
});

describe('SPEC-401: gate — bypass mode', () => {
  test('throws T_PERMISSION without env + CLI flag', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit, env: {}, bypassCliFlag: false });
    try {
      await gate.canUseTool(inv('Bash', { cmd: 'rm -rf /' }), ctx('bypass'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('allows all with both env + CLI flag', async () => {
    const gate = createGate({
      rules: compileRules([]),
      audit: noopAudit,
      env: { NIMBUS_BYPASS_CONFIRMED: '1' },
      bypassCliFlag: true,
    });
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm -rf /' }), ctx('bypass'))).toBe('allow');
    expect(await gate.canUseTool(inv('Write', { path: '/tmp/safe.ts' }), ctx('bypass'))).toBe('allow');
  });

  test('throws with only env (no CLI)', async () => {
    const gate = createGate({
      rules: compileRules([]),
      audit: noopAudit,
      env: { NIMBUS_BYPASS_CONFIRMED: '1' },
      bypassCliFlag: false,
    });
    try {
      await gate.canUseTool(inv('Bash', { cmd: 'x' }), ctx('bypass'));
      throw new Error('should throw');
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });
});

describe('SPEC-401: gate — v0.2 stub modes', () => {
  // 'auto' replaced by 'acceptEdits' (SPEC-404); 'plan' now implemented (SPEC-133).
  for (const mode of ['isolated'] as const) {
    test(`${mode} throws U_MISSING_CONFIG`, async () => {
      const gate = createGate({ rules: compileRules([]), audit: noopAudit });
      try {
        await gate.canUseTool(inv('Read', { path: '/tmp/x' }), ctx(mode));
        throw new Error('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NimbusError);
        expect((err as NimbusError).code).toBe(ErrorCode.U_MISSING_CONFIG);
        expect((err as NimbusError).context['mode']).toBe(mode);
      }
    });
  }
});

describe('SPEC-401: gate — path validator always active', () => {
  test('Read of .env throws X_CRED_ACCESS even when rule says allow', async () => {
    const rules = compileRules([parseRule('Read(/tmp/**)', 'allow', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    try {
      await gate.canUseTool(inv('Read', { path: '/tmp/project/.env' }), ctx('default'));
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_CRED_ACCESS);
    }
  });

  test('Write to ~/.ssh/id_rsa throws X_CRED_ACCESS', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    const { homedir } = await import('node:os');
    try {
      await gate.canUseTool(inv('Write', { path: `${homedir()}/.ssh/id_rsa` }), ctx('default'));
      throw new Error('should throw');
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.X_CRED_ACCESS);
    }
  });
});

describe('SPEC-401: gate — session isolation', () => {
  test('forgetSession clears remembered allows', async () => {
    const rules = compileRules([parseRule('Bash(rm:*)', 'ask', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    gate.rememberAllow('S1', 'Bash:rm:foo');
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx('default'))).toBe('allow');
    gate.forgetSession('S1');
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx('default'))).toBe('ask');
  });

  test('allow remembered for S1 does not leak to S2', async () => {
    const rules = compileRules([parseRule('Bash(rm:*)', 'ask', 'user')]);
    const gate = createGate({ rules, audit: noopAudit });
    gate.rememberAllow('S1', 'Bash:rm:foo');
    const ctx2: PermissionContext = { sessionId: 'S2', workspaceId: 'W1', mode: 'default', cwd: '/tmp/project' };
    expect(await gate.canUseTool(inv('Bash', { cmd: 'rm:foo' }), ctx2)).toBe('ask');
  });
});
