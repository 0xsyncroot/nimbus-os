// tests/skills/registry/analyzer.test.ts — SPEC-310 T12: 9-dim analyzer tests.

import { describe, expect, test } from 'bun:test';
import { analyzeSkill, assertAnalysisAllowed, type RiskReport } from '../../../src/skills/registry/analyzer.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';
import type { SkillManifest } from '../../../src/skills/registry/manifest.ts';

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    description: 'Test skill',
    author: { name: 'Test Author' },
    license: 'MIT',
    minNimbusVersion: '0.3.0',
    entry: {},
    permissions: { sideEffects: 'pure' },
    trust: { tier: 'community', bundleDigest: 'sha256:abc' },
    ...overrides,
  };
}

describe('SPEC-310: static analyzer 9 dims', () => {
  // D1: subprocess
  test('dim:subprocess — flags Bun.spawn in code', () => {
    const report = analyzeSkill(makeManifest(), { code: 'const p = Bun.spawn(["ls"]);' });
    const dim = report.risks.find((r) => r.dim === 'subprocess');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('high');
  });

  test('dim:subprocess — flags child_process', () => {
    const report = analyzeSkill(makeManifest(), { code: "import { exec } from 'child_process';" });
    const dim = report.risks.find((r) => r.dim === 'subprocess');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('high');
  });

  test('dim:subprocess — clean code has no subprocess flag', () => {
    const report = analyzeSkill(makeManifest(), { code: 'const x = 1 + 2;' });
    const dim = report.risks.find((r) => r.dim === 'subprocess');
    expect(dim).toBeUndefined();
  });

  // D2: bash
  test('dim:bash — flags undeclared bash in code', () => {
    const report = analyzeSkill(makeManifest(), { code: 'exec("/bin/sh -c ls")' });
    const dim = report.risks.find((r) => r.dim === 'bash');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('high');
  });

  test('dim:bash — declared bash with few commands is low', () => {
    const m = makeManifest({ permissions: { sideEffects: 'exec', bash: { allow: ['ls', 'echo'] } } });
    const report = analyzeSkill(m, { code: '' });
    const dim = report.risks.find((r) => r.dim === 'bash');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('low');
  });

  test('dim:bash — declared bash with >10 commands is medium', () => {
    const cmds = Array.from({ length: 11 }, (_, i) => `cmd${i}`);
    const m = makeManifest({ permissions: { sideEffects: 'exec', bash: { allow: cmds } } });
    const report = analyzeSkill(m, { code: '' });
    const dim = report.risks.find((r) => r.dim === 'bash');
    expect(dim?.severity).toBe('medium');
  });

  // D3: fsWrite
  test('dim:fsWrite — dangerous path / is high', () => {
    const m = makeManifest({ permissions: { sideEffects: 'write', fsWrite: ['/'] } });
    const report = analyzeSkill(m);
    const dim = report.risks.find((r) => r.dim === 'fsWrite');
    expect(dim?.severity).toBe('high');
  });

  test('dim:fsWrite — /etc is high', () => {
    const m = makeManifest({ permissions: { sideEffects: 'write', fsWrite: ['/etc/hosts'] } });
    const report = analyzeSkill(m);
    const dim = report.risks.find((r) => r.dim === 'fsWrite');
    expect(dim?.severity).toBe('high');
  });

  test('dim:fsWrite — few safe paths is low', () => {
    const m = makeManifest({ permissions: { sideEffects: 'write', fsWrite: ['~/.nimbus/cache'] } });
    const report = analyzeSkill(m);
    const dim = report.risks.find((r) => r.dim === 'fsWrite');
    expect(dim?.severity).toBe('low');
  });

  test('dim:fsWrite — no write declared, no flag', () => {
    const m = makeManifest({ permissions: { sideEffects: 'pure' } });
    const report = analyzeSkill(m);
    expect(report.risks.find((r) => r.dim === 'fsWrite')).toBeUndefined();
  });

  // D4: netEgress
  test('dim:netEgress — wildcard host is high', () => {
    const m = makeManifest({ permissions: { sideEffects: 'read', network: { hosts: ['*'] } } });
    const report = analyzeSkill(m);
    const dim = report.risks.find((r) => r.dim === 'netEgress');
    expect(dim?.severity).toBe('high');
  });

  test('dim:netEgress — single known host is low', () => {
    const m = makeManifest({ permissions: { sideEffects: 'read', network: { hosts: ['api.github.com'] } } });
    const report = analyzeSkill(m);
    const dim = report.risks.find((r) => r.dim === 'netEgress');
    expect(dim?.severity).toBe('low');
  });

  test('dim:netEgress — no network, no flag', () => {
    const m = makeManifest({ permissions: { sideEffects: 'pure' } });
    const report = analyzeSkill(m);
    expect(report.risks.find((r) => r.dim === 'netEgress')).toBeUndefined();
  });

  // D5: secrets
  test('dim:secrets — code+env sensitive is high', () => {
    const m = makeManifest({ permissions: { sideEffects: 'read', env: ['SECRET_API_KEY'] } });
    const code = 'const k = process.env["SECRET_API_KEY"];';
    const report = analyzeSkill(m, { code });
    const dim = report.risks.find((r) => r.dim === 'secrets');
    expect(dim?.severity).toBe('high');
  });

  test('dim:secrets — env only is low', () => {
    const m = makeManifest({ permissions: { sideEffects: 'read', env: ['MY_TOKEN'] } });
    const report = analyzeSkill(m, { code: 'const x = 1;' });
    const dim = report.risks.find((r) => r.dim === 'secrets');
    expect(dim?.severity).toBe('low');
  });

  // D6: dynamicCode
  test('dim:dynamicCode — eval is high', () => {
    const report = analyzeSkill(makeManifest(), { code: 'eval("1+1")' });
    const dim = report.risks.find((r) => r.dim === 'dynamicCode');
    expect(dim?.severity).toBe('high');
  });

  test('dim:dynamicCode — new Function is high', () => {
    const report = analyzeSkill(makeManifest(), { code: 'const f = new Function("return 1")' });
    const dim = report.risks.find((r) => r.dim === 'dynamicCode');
    expect(dim?.severity).toBe('high');
  });

  test('dim:dynamicCode — community skill with eval gets refuse level', () => {
    const report = analyzeSkill(makeManifest(), { code: 'eval("bad")' });
    expect(report.level).toBe('refuse');
  });

  test('dim:dynamicCode — clean code has no flag', () => {
    const report = analyzeSkill(makeManifest(), { code: 'const x = () => 42;' });
    expect(report.risks.find((r) => r.dim === 'dynamicCode')).toBeUndefined();
  });

  // D7: permDelta
  test('dim:permDelta — new network host is medium', () => {
    const installed = makeManifest({
      permissions: { sideEffects: 'read', network: { hosts: ['api.github.com'] } },
    });
    const updated = makeManifest({
      permissions: { sideEffects: 'read', network: { hosts: ['api.github.com', 'evil.com'] } },
    });
    const report = analyzeSkill(updated, { installedManifest: installed });
    const dim = report.risks.find((r) => r.dim === 'permDelta');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('medium');
    expect(dim?.detail).toContain('evil.com');
  });

  test('dim:permDelta — identical perms produces no delta flag', () => {
    const m = makeManifest({
      permissions: { sideEffects: 'read', network: { hosts: ['api.github.com'] } },
    });
    const report = analyzeSkill(m, { installedManifest: m });
    expect(report.risks.find((r) => r.dim === 'permDelta')).toBeUndefined();
  });

  test('dim:permDelta — no installed manifest, no delta flag', () => {
    const m = makeManifest();
    const report = analyzeSkill(m, { installedManifest: null });
    expect(report.risks.find((r) => r.dim === 'permDelta')).toBeUndefined();
  });

  // D8: osvCve (stub → always null in v0.3)
  test('dim:osvCve — stub returns no CVE findings', () => {
    const report = analyzeSkill(makeManifest());
    expect(report.risks.find((r) => r.dim === 'osvCve')).toBeUndefined();
  });

  // D9: entropy
  test('dim:entropy — high entropy block >50 chars is high', () => {
    // Base64-ish blob with high entropy
    const blob = 'aB3cD9eF2gH7iJ5kL1mN8oP4qR6sT0uV3wX9yZ2aB3cD9eF2gH7iJ5kL1mN8o';
    const report = analyzeSkill(makeManifest(), { code: `const x = "${blob}";` });
    const dim = report.risks.find((r) => r.dim === 'entropy');
    expect(dim).toBeDefined();
    expect(dim?.severity).toBe('high');
  });

  test('dim:entropy — normal readable code has no entropy flag', () => {
    const report = analyzeSkill(makeManifest(), {
      code: 'function hello(name) { return "Hello " + name; }',
    });
    expect(report.risks.find((r) => r.dim === 'entropy')).toBeUndefined();
  });

  // Score + level
  test('score 0 on clean skill', () => {
    const report = analyzeSkill(makeManifest(), { code: 'const x = 1;' });
    expect(report.score).toBe(0);
    expect(report.level).toBe('low');
  });

  test('score capped at 100', () => {
    // Pile on everything
    const m = makeManifest({
      permissions: {
        sideEffects: 'exec',
        network: { hosts: ['*'] },
        fsWrite: ['/'],
        bash: { allow: Array.from({ length: 15 }, (_, i) => `cmd${i}`) },
        env: ['API_KEY', 'SECRET_TOKEN'],
      },
    });
    const code = 'eval("x"); Bun.spawn(["rm", "-rf"]); const x = process.env["API_KEY"];';
    const report = analyzeSkill(m, { code });
    expect(report.score).toBeLessThanOrEqual(100);
  });

  // assertAnalysisAllowed
  test('assertAnalysisAllowed — throws T_PERMISSION on refuse level', () => {
    const fakeReport: RiskReport = {
      skill: 'evil-skill',
      version: '1.0.0',
      tier: 'community',
      score: 100,
      level: 'refuse',
      permissions: { sideEffects: 'exec' },
      risks: [],
    };
    expect(() => assertAnalysisAllowed(fakeReport)).toThrow(NimbusError);
    try {
      assertAnalysisAllowed(fakeReport);
    } catch (e) {
      expect((e as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
    }
  });

  test('assertAnalysisAllowed — does not throw on high level', () => {
    const report: RiskReport = {
      skill: 'risky-skill',
      version: '1.0.0',
      tier: 'community',
      score: 60,
      level: 'high',
      permissions: { sideEffects: 'exec' },
      risks: [],
    };
    expect(() => assertAnalysisAllowed(report)).not.toThrow();
  });
});
