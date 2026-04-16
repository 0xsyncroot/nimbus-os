// tests/skills/registry/manifest.test.ts — SPEC-310 T12: manifest schema tests.

import { describe, expect, test } from 'bun:test';
import { parseManifest, validateManifestJSON, type SkillManifest } from '../../../src/skills/registry/manifest.ts';
import { NimbusError, ErrorCode } from '../../../src/observability/errors.ts';

const VALID_MANIFEST: SkillManifest = {
  name: '@nimbus/gh-triage',
  version: '1.0.0',
  description: 'Triage GitHub issues automatically',
  author: { name: 'Nimbus Team', email: 'test@example.com' },
  license: 'MIT',
  minNimbusVersion: '0.3.0',
  entry: { tools: ['bash'] },
  permissions: {
    sideEffects: 'read',
    network: { hosts: ['api.github.com'] },
    env: ['GITHUB_TOKEN'],
  },
  trust: {
    tier: 'community',
    bundleDigest: 'sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  },
};

describe('SPEC-310: manifest schema', () => {
  test('accepts valid manifest', () => {
    const m = parseManifest(VALID_MANIFEST);
    expect(m.name).toBe('@nimbus/gh-triage');
    expect(m.version).toBe('1.0.0');
    expect(m.trust.tier).toBe('community');
    expect(m.permissions.sideEffects).toBe('read');
  });

  test('accepts unscoped name', () => {
    const m = parseManifest({ ...VALID_MANIFEST, name: 'my-skill' });
    expect(m.name).toBe('my-skill');
  });

  test('accepts trusted tier', () => {
    const m = parseManifest({
      ...VALID_MANIFEST,
      trust: { tier: 'trusted', signedBy: 'nimbus-team', bundleDigest: 'sha256:abc' },
    });
    expect(m.trust.tier).toBe('trusted');
  });

  test('accepts local tier', () => {
    const m = parseManifest({
      ...VALID_MANIFEST,
      trust: { tier: 'local', bundleDigest: 'local' },
    });
    expect(m.trust.tier).toBe('local');
  });

  test('rejects missing name', () => {
    const bad = { ...VALID_MANIFEST };
    // @ts-expect-error intentional
    delete bad.name;
    expect(() => parseManifest(bad)).toThrow(NimbusError);
  });

  test('rejects invalid semver version', () => {
    expect(() => parseManifest({ ...VALID_MANIFEST, version: 'not-semver' })).toThrow(NimbusError);
  });

  test('rejects description >140 chars', () => {
    const longDesc = 'x'.repeat(141);
    expect(() => parseManifest({ ...VALID_MANIFEST, description: longDesc })).toThrow(NimbusError);
  });

  test('rejects invalid sideEffects value', () => {
    expect(() =>
      parseManifest({
        ...VALID_MANIFEST,
        permissions: { ...VALID_MANIFEST.permissions, sideEffects: 'invalid' as never },
      }),
    ).toThrow(NimbusError);
  });

  test('sideEffects accepts all 4 SPEC-103 values', () => {
    for (const se of ['pure', 'read', 'write', 'exec'] as const) {
      const m = parseManifest({
        ...VALID_MANIFEST,
        permissions: { ...VALID_MANIFEST.permissions, sideEffects: se },
      });
      expect(m.permissions.sideEffects).toBe(se);
    }
  });

  test('rejects invalid trust tier', () => {
    expect(() =>
      parseManifest({
        ...VALID_MANIFEST,
        trust: { tier: 'untrusted' as never, bundleDigest: 'sha256:abc' },
      }),
    ).toThrow(NimbusError);
  });

  test('accepts manifest without optional fields', () => {
    const minimal = {
      ...VALID_MANIFEST,
      author: { name: 'Dev' }, // no email
      entry: {},               // no tools/code
      permissions: { sideEffects: 'pure' as const },
    };
    const m = parseManifest(minimal);
    expect(m.author.email).toBeUndefined();
  });

  test('validateManifestJSON parses valid JSON string', () => {
    const m = validateManifestJSON(JSON.stringify(VALID_MANIFEST));
    expect(m.name).toBe(VALID_MANIFEST.name);
  });

  test('validateManifestJSON throws on invalid JSON', () => {
    expect(() => validateManifestJSON('not json')).toThrow(NimbusError);
  });

  test('validateManifestJSON error has T_VALIDATION code', () => {
    try {
      validateManifestJSON('not json');
    } catch (e) {
      expect(e instanceof NimbusError).toBe(true);
      expect((e as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    }
  });
});
