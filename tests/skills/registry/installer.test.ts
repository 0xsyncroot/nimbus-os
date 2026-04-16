// tests/skills/registry/installer.test.ts — SPEC-310 T12: installer flow tests.
// Focuses on parseNameVersion (T8), riskReport confirm logic, and mock flows.

import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { parseNameVersion } from '../../../src/skills/registry/installer.ts';
import {
  formatRiskReport,
  printAutoInstallBanner,
} from '../../../src/skills/registry/riskReport.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';
import type { RiskReport } from '../../../src/skills/registry/analyzer.ts';

// Helpers
function makeReport(overrides: Partial<RiskReport> = {}): RiskReport {
  return {
    skill: 'my-skill',
    version: '1.0.0',
    tier: 'community',
    score: 0,
    level: 'low',
    permissions: { sideEffects: 'pure' },
    risks: [],
    ...overrides,
  };
}

describe('SPEC-310: T8 exact-version resolution', () => {
  test('parses unscoped name without version', () => {
    expect(parseNameVersion('my-skill')).toEqual({ name: 'my-skill', version: undefined });
  });

  test('parses unscoped name with version', () => {
    expect(parseNameVersion('my-skill@1.2.3')).toEqual({ name: 'my-skill', version: '1.2.3' });
  });

  test('parses scoped name without version', () => {
    expect(parseNameVersion('@nimbus/gh-triage')).toEqual({
      name: '@nimbus/gh-triage',
      version: undefined,
    });
  });

  test('parses scoped name with version', () => {
    expect(parseNameVersion('@nimbus/gh-triage@2.0.1')).toEqual({
      name: '@nimbus/gh-triage',
      version: '2.0.1',
    });
  });

  test('handles pre-release version', () => {
    expect(parseNameVersion('my-skill@1.0.0-beta.1')).toEqual({
      name: 'my-skill',
      version: '1.0.0-beta.1',
    });
  });

  test('handles name with no @ at all', () => {
    expect(parseNameVersion('bare')).toEqual({ name: 'bare', version: undefined });
  });
});

describe('SPEC-310: risk report formatting', () => {
  test('formatRiskReport includes skill name and version', () => {
    const report = makeReport({ skill: '@nimbus/gh-triage', version: '1.4.2', tier: 'trusted' });
    const text = formatRiskReport(report);
    expect(text).toContain('@nimbus/gh-triage');
    expect(text).toContain('1.4.2');
    expect(text).toContain('TRUSTED');
  });

  test('formatRiskReport shows LOW level', () => {
    const report = makeReport({ level: 'low', score: 5 });
    const text = formatRiskReport(report);
    expect(text).toContain('LOW');
    expect(text).toContain('5/100');
  });

  test('formatRiskReport shows MEDIUM level', () => {
    const report = makeReport({ level: 'medium', score: 35 });
    const text = formatRiskReport(report);
    expect(text).toContain('MEDIUM');
  });

  test('formatRiskReport shows HIGH level', () => {
    const report = makeReport({ level: 'high', score: 70 });
    const text = formatRiskReport(report);
    expect(text).toContain('HIGH');
    expect(text).toContain('70/100');
  });

  test('formatRiskReport shows risk dim details', () => {
    const report = makeReport({
      risks: [
        { dim: 'subprocess', severity: 'high', detail: 'Bun.spawn detected' },
        { dim: 'netEgress', severity: 'medium', detail: '3 hosts declared' },
      ],
    });
    const text = formatRiskReport(report);
    expect(text).toContain('subprocess');
    expect(text).toContain('Bun.spawn detected');
    expect(text).toContain('netEgress');
    expect(text).toContain('3 hosts declared');
  });

  test('formatRiskReport shows permissions', () => {
    const report = makeReport({
      permissions: {
        sideEffects: 'read',
        network: { hosts: ['api.github.com'] },
        env: ['GH_TOKEN'],
      },
    });
    const text = formatRiskReport(report);
    expect(text).toContain('sideEffects: read');
    expect(text).toContain('api.github.com');
    expect(text).toContain('GH_TOKEN');
  });

  test('formatRiskReport shows "No risk signals detected" for clean skill', () => {
    const report = makeReport({ risks: [] });
    const text = formatRiskReport(report);
    expect(text).toContain('No risk signals detected');
  });
});

describe('SPEC-310: risk confirm rules', () => {
  // We test confirmInstall indirectly via module behavior
  // Full interactive tests need TTY; we test the non-TTY paths

  test('confirmInstall throws T_PERMISSION for REFUSE level', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    const report = makeReport({ level: 'refuse', skill: 'bad-skill' });
    await expect(confirmInstall(report, {})).rejects.toThrow(NimbusError);
    try {
      await confirmInstall(report, {});
    } catch (e) {
      expect((e as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('confirmInstall throws T_PERMISSION for MED in non-TTY without --yes', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    const report = makeReport({ level: 'medium', skill: 'med-skill' });
    await expect(confirmInstall(report, { isTTY: false, yes: false })).rejects.toThrow(NimbusError);
  });

  test('confirmInstall throws T_PERMISSION for HIGH in non-TTY even with --yes', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    const report = makeReport({ level: 'high', skill: 'high-skill' });
    await expect(confirmInstall(report, { isTTY: false, yes: true })).rejects.toThrow(NimbusError);
  });

  test('confirmInstall throws T_PERMISSION for LOW in non-TTY without --yes', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    const report = makeReport({ level: 'low', skill: 'low-skill' });
    await expect(confirmInstall(report, { isTTY: false, yes: false })).rejects.toThrow(NimbusError);
  });

  test('confirmInstall allows TRUSTED auto-install (no confirm required)', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    // Capture stdout to check banner
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    try {
      const report = makeReport({ tier: 'trusted', level: 'low', skill: 'gh-triage', version: '1.4.2' });
      await confirmInstall(report, { isTTY: false });
      // Should succeed without throwing
      const output = chunks.join('');
      expect(output).toContain('auto-install');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('--yes flag accepted for LOW risk with no TTY', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    // Capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    try {
      const report = makeReport({ level: 'low', skill: 'safe-skill' });
      // Should not throw
      await confirmInstall(report, { isTTY: false, yes: true });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('--yes flag ignored for MEDIUM risk (throws)', async () => {
    const { confirmInstall } = await import('../../../src/skills/registry/riskReport.ts');
    const report = makeReport({ level: 'medium', skill: 'med-skill' });
    // non-TTY + yes=true: MED still needs TTY confirm
    await expect(confirmInstall(report, { isTTY: false, yes: true })).rejects.toThrow(NimbusError);
  });
});

describe('SPEC-310: printAutoInstallBanner', () => {
  test('prints one-line banner for trusted auto-install', () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string | Uint8Array) => {
      if (typeof s === 'string') chunks.push(s);
      return true;
    };
    try {
      printAutoInstallBanner('gh-triage', '1.4.2');
      const output = chunks.join('');
      expect(output).toContain('auto-installed');
      expect(output).toContain('gh-triage');
      expect(output).toContain('1.4.2');
      expect(output).toContain('trusted');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
