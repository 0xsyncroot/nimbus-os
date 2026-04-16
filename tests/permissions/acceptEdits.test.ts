// tests/permissions/acceptEdits.test.ts — SPEC-404 §6.1 unit + integration tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import { __resetPathValidatorCache } from '../../src/permissions/pathValidator.ts';
import { compileRules } from '../../src/permissions/rule.ts';
import { createGate } from '../../src/permissions/gate.ts';
import { parseMode, narrow } from '../../src/permissions/mode.ts';
import type { PermissionContext, PermissionMode, ToolInvocation, SideEffectTier } from '../../src/permissions/index.ts';

const origNimbusHome = process.env['NIMBUS_HOME'];
let tmpHome: string;
const noopAudit = async () => { /* noop */ };

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'nimbus-accept-edits-'));
  process.env['NIMBUS_HOME'] = tmpHome;
  __resetPathValidatorCache();
});

afterAll(() => {
  if (origNimbusHome !== undefined) process.env['NIMBUS_HOME'] = origNimbusHome;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

function ctx(mode: PermissionMode): PermissionContext {
  return { sessionId: 'S1', workspaceId: 'W1', mode, cwd: '/tmp/project' };
}

function inv(
  name: string,
  input: Record<string, unknown>,
  sideEffects?: SideEffectTier,
): ToolInvocation {
  return { name, input, sideEffects };
}

// ── T1: parseMode alias resolution ───────────────────────────────────────────

describe('SPEC-404: parseMode — alias resolution', () => {
  test("parseMode('auto') === 'acceptEdits'", () => {
    expect(parseMode('auto')).toBe('acceptEdits');
  });

  test("parseMode('acceptEdits') === 'acceptEdits'", () => {
    expect(parseMode('acceptEdits')).toBe('acceptEdits');
  });

  test("parseMode('default') === 'default'", () => {
    expect(parseMode('default')).toBe('default');
  });

  test("parseMode('readonly') === 'readonly'", () => {
    expect(parseMode('readonly')).toBe('readonly');
  });

  test("parseMode('bypass') === 'bypass'", () => {
    expect(parseMode('bypass')).toBe('bypass');
  });

  test('parseMode(unknown) throws U_BAD_COMMAND', () => {
    expect(() => parseMode('superuser')).toThrow(NimbusError);
    try {
      parseMode('superuser');
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });
});

// ── T2: gate decision matrix — 4 modes × 4 sideEffects ───────────────────────

describe('SPEC-404: gate — acceptEdits mode decision matrix', () => {
  const gate = createGate({ rules: compileRules([]), audit: noopAudit });

  // acceptEdits + write → allow (fast-path)
  test('acceptEdits + sideEffects:write → allow', async () => {
    expect(
      await gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }, 'write'), ctx('acceptEdits')),
    ).toBe('allow');
  });

  // acceptEdits + exec → ask (falls through to default rules)
  test('acceptEdits + sideEffects:exec → ask (Bash prompts)', async () => {
    expect(
      await gate.canUseTool(inv('Bash', { cmd: 'echo hello' }, 'exec'), ctx('acceptEdits')),
    ).toBe('ask');
  });

  // acceptEdits + read → allow
  test('acceptEdits + sideEffects:read → allow', async () => {
    expect(
      await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }, 'read'), ctx('acceptEdits')),
    ).toBe('allow');
  });

  // acceptEdits + pure → allow
  test('acceptEdits + sideEffects:pure → allow', async () => {
    expect(
      await gate.canUseTool(inv('SearchTool', {}, 'pure'), ctx('acceptEdits')),
    ).toBe('allow');
  });

  // readonly + write → deny (unchanged)
  test('readonly + sideEffects:write → deny', async () => {
    expect(
      await gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }, 'write'), ctx('readonly')),
    ).toBe('deny');
  });

  // readonly + exec → deny (Bash is in DESTRUCTIVE_TOOLS)
  test('readonly + sideEffects:exec → deny', async () => {
    expect(
      await gate.canUseTool(inv('Bash', { cmd: 'ls' }, 'exec'), ctx('readonly')),
    ).toBe('deny');
  });

  // readonly + read → allow
  test('readonly + sideEffects:read → allow', async () => {
    expect(
      await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }, 'read'), ctx('readonly')),
    ).toBe('allow');
  });

  // readonly + pure → deny (unknown tool in readonly is deny-closed)
  test('readonly + sideEffects:pure (unknown tool) → deny', async () => {
    expect(
      await gate.canUseTool(inv('UnknownPureTool', {}, 'pure'), ctx('readonly')),
    ).toBe('deny');
  });

  // default + write → ask (no rule match for destructive)
  test('default + sideEffects:write → ask', async () => {
    expect(
      await gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }, 'write'), ctx('default')),
    ).toBe('ask');
  });

  // default + exec → ask (no rule match for Bash)
  test('default + sideEffects:exec → ask', async () => {
    expect(
      await gate.canUseTool(inv('Bash', { cmd: 'ls' }, 'exec'), ctx('default')),
    ).toBe('ask');
  });

  // default + read → allow
  test('default + sideEffects:read → allow', async () => {
    expect(
      await gate.canUseTool(inv('Read', { path: '/tmp/project/a.ts' }, 'read'), ctx('default')),
    ).toBe('allow');
  });

  // default + pure → ask (unknown tool in default)
  test('default + sideEffects:pure (unknown tool) → ask', async () => {
    expect(
      await gate.canUseTool(inv('UnknownPureTool', {}, 'pure'), ctx('default')),
    ).toBe('ask');
  });
});

// ── T4: narrow() — sub-agent lattice enforcement ─────────────────────────────

describe('SPEC-404: narrow() — sub-agent permission lattice', () => {
  test('narrow(acceptEdits, readonly) → readonly (valid narrowing)', () => {
    expect(narrow('acceptEdits', 'readonly')).toBe('readonly');
  });

  test('narrow(acceptEdits, default) → default (valid narrowing)', () => {
    expect(narrow('acceptEdits', 'default')).toBe('default');
  });

  test('narrow(acceptEdits, acceptEdits) → acceptEdits (same level)', () => {
    expect(narrow('acceptEdits', 'acceptEdits')).toBe('acceptEdits');
  });

  test('narrow(acceptEdits, bypass) → throws T_PERMISSION (cannot widen)', () => {
    expect(() => narrow('acceptEdits', 'bypass')).toThrow(NimbusError);
    try {
      narrow('acceptEdits', 'bypass');
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('narrow(default, bypass) → throws T_PERMISSION', () => {
    expect(() => narrow('default', 'bypass')).toThrow(NimbusError);
  });

  test('narrow(readonly, acceptEdits) → throws T_PERMISSION', () => {
    expect(() => narrow('readonly', 'acceptEdits')).toThrow(NimbusError);
  });

  test('narrow(bypass, acceptEdits) → acceptEdits (valid narrowing from bypass)', () => {
    expect(narrow('bypass', 'acceptEdits')).toBe('acceptEdits');
  });
});

// ── Integration: 3 Write ops auto-allow; 1 Bash prompts ──────────────────────

describe('SPEC-404: integration — acceptEdits session flow', () => {
  test('3 Write ops auto-allow without prompt in acceptEdits mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    const results = await Promise.all([
      gate.canUseTool(inv('Write', { path: '/tmp/project/a.ts' }, 'write'), ctx('acceptEdits')),
      gate.canUseTool(inv('Edit', { path: '/tmp/project/b.ts' }, 'write'), ctx('acceptEdits')),
      gate.canUseTool(inv('NotebookEdit', { path: '/tmp/project/c.ipynb' }, 'write'), ctx('acceptEdits')),
    ]);
    expect(results).toEqual(['allow', 'allow', 'allow']);
  });

  test('Bash prompts (ask) in acceptEdits mode', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    const result = await gate.canUseTool(
      inv('Bash', { cmd: 'echo hello' }, 'exec'),
      ctx('acceptEdits'),
    );
    expect(result).toBe('ask');
  });

  test('/mode default after acceptEdits — subsequent Write prompts', async () => {
    const gate = createGate({ rules: compileRules([]), audit: noopAudit });
    // In acceptEdits: Write auto-allows
    expect(
      await gate.canUseTool(inv('Write', { path: '/tmp/project/x.ts' }, 'write'), ctx('acceptEdits')),
    ).toBe('allow');
    // After switching back to default: Write asks
    expect(
      await gate.canUseTool(inv('Write', { path: '/tmp/project/x.ts' }, 'write'), ctx('default')),
    ).toBe('ask');
  });
});
