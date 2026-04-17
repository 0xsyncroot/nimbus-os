// tests/lint/layerRules.test.ts — SPEC-833: unit tests for layer rule definitions.
//
// Tests verify two things:
//   1. The LAYER_RULES data structure is well-formed and complete.
//   2. toEslintNoRestrictedPaths() produces zones that catch known violation patterns.
//
// We do NOT run the full eslint engine here (that's done by `bun run lint` in CI).
// Instead we test the rule logic directly, keeping the test fast and dependency-free.

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { LAYER_RULES, toEslintNoRestrictedPaths, type LayerRule } from '../../scripts/lint/layerRules.ts';

// ── LAYER_RULES shape ─────────────────────────────────────────────────────────

describe('SPEC-833: LAYER_RULES definition', () => {
  test('LAYER_RULES is a non-empty array', () => {
    expect(Array.isArray(LAYER_RULES)).toBe(true);
    expect(LAYER_RULES.length).toBeGreaterThan(0);
  });

  test('every rule has id, from, forbid, reason', () => {
    for (const rule of LAYER_RULES) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
      expect(Array.isArray(rule.from)).toBe(true);
      expect(rule.from.length).toBeGreaterThan(0);
      expect(Array.isArray(rule.forbid)).toBe(true);
      expect(rule.forbid.length).toBeGreaterThan(0);
      expect(typeof rule.reason).toBe('string');
      expect(rule.reason.length).toBeGreaterThan(0);
    }
  });

  test('rule ids are unique', () => {
    const ids = LAYER_RULES.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('all reason strings reference SPEC-833 or META-001', () => {
    for (const rule of LAYER_RULES) {
      const hasRef = rule.reason.includes('SPEC-833') || rule.reason.includes('META-001');
      expect(hasRef).toBe(true);
    }
  });
});

// ── META-001 §2.2 required rules present ─────────────────────────────────────

describe('SPEC-833: required META-001 layer violations are covered', () => {
  function ruleCovers(rules: LayerRule[], fromPattern: string, forbidPattern: string): boolean {
    return rules.some(
      (r) =>
        r.from.some((f) => f.startsWith(fromPattern)) &&
        r.forbid.some((fb) => fb.startsWith(forbidPattern)),
    );
  }

  test('tools cannot import channels (V1 violation fixed in SPEC-833)', () => {
    expect(ruleCovers(LAYER_RULES, 'src/tools', 'src/channels')).toBe(true);
  });

  test('channels cannot import tools', () => {
    expect(ruleCovers(LAYER_RULES, 'src/channels', 'src/tools')).toBe(true);
  });

  test('core cannot import channels', () => {
    expect(ruleCovers(LAYER_RULES, 'src/core', 'src/channels')).toBe(true);
  });

  test('core cannot import tools', () => {
    expect(ruleCovers(LAYER_RULES, 'src/core', 'src/tools')).toBe(true);
  });

  test('ir is pure (no channels)', () => {
    expect(ruleCovers(LAYER_RULES, 'src/ir', 'src/channels')).toBe(true);
  });

  test('ir is pure (no tools)', () => {
    expect(ruleCovers(LAYER_RULES, 'src/ir', 'src/tools')).toBe(true);
  });

  test('platform is a leaf (no core imports)', () => {
    expect(ruleCovers(LAYER_RULES, 'src/platform', 'src/core')).toBe(true);
  });

  test('platform is a leaf (no channels imports)', () => {
    expect(ruleCovers(LAYER_RULES, 'src/platform', 'src/channels')).toBe(true);
  });
});

// ── toEslintNoRestrictedPaths output ─────────────────────────────────────────

describe('SPEC-833: toEslintNoRestrictedPaths()', () => {
  const config = toEslintNoRestrictedPaths(LAYER_RULES);

  test('returns object with zones array', () => {
    expect(typeof config).toBe('object');
    expect(Array.isArray(config.zones)).toBe(true);
    expect(config.zones.length).toBeGreaterThan(0);
  });

  test('each zone has target, from, message', () => {
    for (const zone of config.zones) {
      expect(typeof zone.target).toBe('string');
      expect(typeof zone.from).toBe('string');
      expect(typeof zone.message).toBe('string');
    }
  });

  test('tools→channels violation zone is present', () => {
    const found = config.zones.some(
      (z) => z.target.includes('src/tools') && z.from.includes('src/channels'),
    );
    expect(found).toBe(true);
  });

  test('channels→tools violation zone is present', () => {
    const found = config.zones.some(
      (z) => z.target.includes('src/channels') && z.from.includes('src/tools'),
    );
    expect(found).toBe(true);
  });

  test('number of zones >= number of (from × forbid) combos across all rules', () => {
    const expected = LAYER_RULES.reduce(
      (acc, r) => acc + r.from.length * r.forbid.length,
      0,
    );
    expect(config.zones.length).toBe(expected);
  });
});

// ── V1 fix verification: Telegram.ts no longer imports channels/ ─────────────

describe('SPEC-833: V1 fix — Telegram.ts does not import channels/', () => {
  // Use fileURLToPath to convert file:// URL to OS-native absolute path.
  // On Windows, URL.pathname yields `/C:/...` which Bun.file cannot resolve;
  // fileURLToPath correctly produces `C:\\...`. Cross-platform safe.
  const telegramPath = fileURLToPath(
    new URL('../../src/tools/builtin/Telegram.ts', import.meta.url),
  );

  test('src/tools/builtin/Telegram.ts has no direct channels/ import', async () => {
    const file = await Bun.file(telegramPath).text();
    // Must NOT contain a direct import of src/channels/**
    const hasChannelsImport = /from\s+['"].*channels\/(?!.*channelPorts)/.test(file);
    expect(hasChannelsImport).toBe(false);
  });

  test('src/tools/builtin/Telegram.ts imports channelPorts (abstract port)', async () => {
    const file = await Bun.file(telegramPath).text();
    expect(file).toContain('channelPorts');
  });
});

// ── V1 fix verification: todoWriteTool.ts no longer imports channels/ ─────────

describe('SPEC-833: V1 fix — todoWriteTool.ts does not import channels/', () => {
  const todoWritePath = fileURLToPath(
    new URL('../../src/tools/todoWriteTool.ts', import.meta.url),
  );

  test('src/tools/todoWriteTool.ts has no channels/ import', async () => {
    const file = await Bun.file(todoWritePath).text();
    const hasChannelsImport = /from\s+['"].*channels\//.test(file);
    expect(hasChannelsImport).toBe(false);
  });
});
