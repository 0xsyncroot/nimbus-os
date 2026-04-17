// layerRules.ts — SPEC-833: layer DAG definition for eslint no-restricted-paths.
//
// Encodes the META-001 §2.2 layer DAG as typed LayerRule objects, then exports
// a converter that produces an eslint `no-restricted-paths` zone config.
//
// Layer DAG (top = most constrained, leaf = most permissive):
//   core / ir / providers / protocol
//     ↓ (cannot import)
//   channels   tools   platform
//     ↓
//   channels cannot import tools (must emit UIIntent via core/ui — SPEC-830)
//   tools    cannot import channels (V1 violation fixed by SPEC-833)
//   platform is a leaf — no internal deps besides itself

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LayerRule {
  /** Human-readable label used in error messages and tests. */
  id: string;
  /** File glob patterns that are the IMPORTER (from layer). */
  from: string[];
  /** File glob patterns that are FORBIDDEN imports (to layer). */
  forbid: string[];
  /** Message shown in eslint output when the rule fires. */
  reason: string;
}

// ── Layer DAG ─────────────────────────────────────────────────────────────────

export const LAYER_RULES: LayerRule[] = [
  {
    id: 'core-no-channels',
    from: ['src/core/**'],
    forbid: ['src/channels/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/core/ must not import src/channels/. ' +
      'Use abstract port (src/core/channelPorts.ts) if core needs to communicate with channels.',
  },
  {
    id: 'core-no-tools',
    from: ['src/core/**'],
    forbid: ['src/tools/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/core/ must not import src/tools/. ' +
      'Tool registration goes through src/tools/index.ts injected at startup.',
  },
  {
    id: 'ir-no-channels',
    from: ['src/ir/**'],
    forbid: ['src/channels/**', 'src/tools/**', 'src/platform/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/ir/ is pure — no channels, tools, or platform imports.',
  },
  {
    id: 'providers-no-channels',
    from: ['src/providers/**'],
    forbid: ['src/channels/**', 'src/tools/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/providers/ must not import channels or tools. ' +
      'Providers are pure adapters — only ir/ types allowed.',
  },
  {
    id: 'tools-no-channels',
    from: ['src/tools/**'],
    forbid: ['src/channels/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/tools/ must not import src/channels/ directly. ' +
      'Use abstract port (src/core/channelPorts.ts) for channel communication. ' +
      'This was a V1 violation in Telegram.ts (fixed by SPEC-833).',
  },
  {
    id: 'channels-no-tools',
    from: ['src/channels/**'],
    forbid: ['src/tools/**'],
    reason:
      '[SPEC-833 / META-001 §2.2] src/channels/ must not import src/tools/ directly. ' +
      'Emit UIIntent via core/ui (SPEC-830) — channels orchestrate, not invoke.',
  },
  {
    id: 'platform-leaf',
    from: ['src/platform/**'],
    forbid: [
      'src/core/**',
      'src/ir/**',
      'src/providers/**',
      'src/channels/**',
      'src/tools/**',
    ],
    reason:
      '[SPEC-833 / META-001 §2.2] src/platform/ is a leaf layer — no internal nimbus deps. ' +
      'Platform modules are independently usable (keychain, fs, secrets).',
  },
];

// ── eslint no-restricted-paths converter ─────────────────────────────────────

interface EslintZone {
  target: string;
  from: string;
  message?: string;
}

/**
 * Convert LAYER_RULES into the `zones` array expected by eslint-plugin-import's
 * `import/no-restricted-paths` rule.
 *
 * Usage in .eslintrc.js:
 *   import { toEslintNoRestrictedPaths } from './scripts/lint/layerRules.ts';
 *   rules: { 'import/no-restricted-paths': ['error', toEslintNoRestrictedPaths(LAYER_RULES)] }
 */
export function toEslintNoRestrictedPaths(rules: LayerRule[]): { zones: EslintZone[] } {
  const zones: EslintZone[] = [];
  for (const rule of rules) {
    for (const fromGlob of rule.from) {
      for (const forbidGlob of rule.forbid) {
        zones.push({
          target: fromGlob,
          from: forbidGlob,
          message: rule.reason,
        });
      }
    }
  }
  return { zones };
}
