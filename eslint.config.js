// eslint.config.js — SPEC-833: flat config for ESLint 10+.
// Enforces META-001 §2.2 layer DAG via import/no-restricted-paths.
//
// Layer rules are inlined here (cannot import .ts at eslint runtime — Node ESM).
// The canonical typed definition lives in scripts/lint/layerRules.ts for tests.

import importPlugin from 'eslint-plugin-import';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// ── Layer DAG zones (mirrors LAYER_RULES in scripts/lint/layerRules.ts) ───────
// Each zone: { target: importer glob, from: forbidden import glob, message }
const layerZones = [
  // core cannot import channels or tools
  { target: 'src/core/**', from: 'src/channels/**', message: '[SPEC-833/META-001§2.2] src/core/ must not import src/channels/. Use src/core/channelPorts.ts abstract port.' },
  { target: 'src/core/**', from: 'src/tools/**', message: '[SPEC-833/META-001§2.2] src/core/ must not import src/tools/. Tool registration is injected at startup.' },

  // ir is pure — no channels, tools, or platform
  { target: 'src/ir/**', from: 'src/channels/**', message: '[SPEC-833/META-001§2.2] src/ir/ is pure — no channels imports.' },
  { target: 'src/ir/**', from: 'src/tools/**', message: '[SPEC-833/META-001§2.2] src/ir/ is pure — no tools imports.' },
  { target: 'src/ir/**', from: 'src/platform/**', message: '[SPEC-833/META-001§2.2] src/ir/ is pure — no platform imports.' },

  // providers cannot import channels or tools
  { target: 'src/providers/**', from: 'src/channels/**', message: '[SPEC-833/META-001§2.2] src/providers/ must not import channels. Providers are pure adapters.' },
  { target: 'src/providers/**', from: 'src/tools/**', message: '[SPEC-833/META-001§2.2] src/providers/ must not import tools. Providers are pure adapters.' },

  // tools cannot import channels (V1 violation — fixed in SPEC-833)
  { target: 'src/tools/**', from: 'src/channels/**', message: '[SPEC-833/META-001§2.2] src/tools/ must not import src/channels/ directly. Use src/core/channelPorts.ts abstract port.' },

  // channels cannot import tools (must emit UIIntent via core/ui — SPEC-830)
  { target: 'src/channels/**', from: 'src/tools/**', message: '[SPEC-833/META-001§2.2] src/channels/ must not import src/tools/ directly. Emit UIIntent via core/ui (SPEC-830).' },

  // platform is a leaf — no internal deps
  { target: 'src/platform/**', from: 'src/core/**', message: '[SPEC-833/META-001§2.2] src/platform/ is a leaf — no internal nimbus deps.' },
  { target: 'src/platform/**', from: 'src/ir/**', message: '[SPEC-833/META-001§2.2] src/platform/ is a leaf — no internal nimbus deps.' },
  { target: 'src/platform/**', from: 'src/providers/**', message: '[SPEC-833/META-001§2.2] src/platform/ is a leaf — no internal nimbus deps.' },
  { target: 'src/platform/**', from: 'src/channels/**', message: '[SPEC-833/META-001§2.2] src/platform/ is a leaf — no internal nimbus deps.' },
  { target: 'src/platform/**', from: 'src/tools/**', message: '[SPEC-833/META-001§2.2] src/platform/ is a leaf — no internal nimbus deps.' },
];

export default [
  {
    ignores: ['node_modules/**', 'dist/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      import: importPlugin,
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // ── META-001 §2.2 layer enforcement ──────────────────────────────────
      'import/no-restricted-paths': ['error', { zones: layerZones }],

      // ── TypeScript strict baseline ───────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
