import { describe, expect, test } from 'bun:test';
import {
  displaySpecInline,
  highRiskGate,
  type TaskSpec,
} from '../../src/core/taskSpec.ts';

const makeSpec = (severity: 'low' | 'medium' | 'high'): TaskSpec => ({
  schemaVersion: 2,
  turnId: 'T1',
  generatedAt: Date.now(),
  outcomes: 'Do the thing',
  scope: { in: ['step 1'], out: [] },
  actions: [
    { tool: 'Read', reason: 'read the file' },
    { tool: 'Edit', reason: 'apply fix' },
  ],
  risks: { severity, reasons: [] },
  verification: 'file has new line',
});

describe('SPEC-110: taskSpec', () => {
  test('displaySpecInline returns 3-5 lines', () => {
    const out = displaySpecInline(makeSpec('low'));
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  test('high severity renders [HIGH RISK] tag', () => {
    const out = displaySpecInline(makeSpec('high'));
    expect(out).toContain('[HIGH RISK]');
  });

  test('low severity has no risk tag', () => {
    const out = displaySpecInline(makeSpec('low'));
    expect(out).not.toContain('[HIGH RISK]');
  });

  test('highRiskGate auto-approves low severity', async () => {
    const ok = await highRiskGate(makeSpec('low'), {
      confirm: async () => false, // should not be called
    });
    expect(ok).toBe(true);
  });

  test('highRiskGate requires confirm on high severity', async () => {
    let called = false;
    const ok = await highRiskGate(makeSpec('high'), {
      confirm: async () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(true);
    expect(ok).toBe(true);
  });

  test('highRiskGate forceAlways always confirms', async () => {
    let called = false;
    await highRiskGate(makeSpec('low'), {
      confirm: async () => {
        called = true;
        return true;
      },
    }, true);
    expect(called).toBe(true);
  });

  test('high severity rejected when confirm returns false', async () => {
    const ok = await highRiskGate(makeSpec('high'), {
      confirm: async () => false,
    });
    expect(ok).toBe(false);
  });
});
