// userOverrides.ts — SPEC-849: Load + Zod-validate ~/.nimbus/keybindings.json.
// Invalid config → pino warn + fallback to defaults (never crash on bad config).
// Path resolved via platform/paths.ts::nimbusHome — no arbitrary file reads.
// Reserved keys (ctrl+c, ctrl+d) rejected at validation time.

import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../../../observability/logger.ts';
import { nimbusHome } from '../../../../platform/paths.ts';
import { assertNotReserved } from './reservedShortcuts.ts';
import type { KeybindingAction } from './defaultBindings.ts';
import type { KeybindingContext } from './index.ts';

// ── Zod schema ─────────────────────────────────────────────────────────────────

const KeybindingActionSchema = z.enum([
  'app:interrupt', 'app:exit', 'app:redraw', 'app:toggleHelp',
  'chat:submit', 'chat:cancel', 'chat:cycleMode', 'chat:historyPrev', 'chat:historyNext',
  'autocomplete:accept', 'autocomplete:dismiss', 'autocomplete:next', 'autocomplete:prev',
  'select:accept', 'select:cancel', 'select:next', 'select:prev',
  'confirmation:yes', 'confirmation:no', 'confirmation:toggleExplanation', 'confirmation:cycleMode',
  'scroll:pageUp', 'scroll:pageDown', 'scroll:home', 'scroll:end',
  'modal:openHelp', 'modal:openModel', 'modal:openCost', 'modal:openMemory',
  'modal:openDoctor', 'modal:openStatus',
  'history:search',
] as const satisfies readonly KeybindingAction[]);

const KeybindingContextSchema = z.enum([
  'Global', 'Chat', 'Autocomplete', 'Select', 'Confirmation',
  'Scroll', 'HistorySearch', 'Transcript', 'Help',
] as const satisfies readonly KeybindingContext[]);

// Schema: { "<context>": { "<key>": "<action>" } }
const UserOverridesSchema = z.record(
  KeybindingContextSchema,
  z.record(z.string(), KeybindingActionSchema),
);

export type UserOverrides = z.infer<typeof UserOverridesSchema>;

// ── Load function ──────────────────────────────────────────────────────────────

/**
 * Loads and validates ~/.nimbus/keybindings.json.
 * Returns parsed overrides on success, or undefined if file absent/invalid.
 * Reserved keys (ctrl+c, ctrl+d) in any context are rejected with a warning.
 */
export async function loadUserOverrides(customPath?: string): Promise<UserOverrides | undefined> {
  const filePath = customPath ?? join(nimbusHome(), 'keybindings.json');

  let raw: string;
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return undefined;
    raw = await file.text();
  } catch (err) {
    logger.warn({ err, filePath }, '[SPEC-849] userOverrides: failed to read keybindings.json — using defaults');
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, filePath }, '[SPEC-849] userOverrides: keybindings.json is not valid JSON — using defaults');
    return undefined;
  }

  const result = UserOverridesSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { errors: result.error.flatten(), filePath },
      '[SPEC-849] userOverrides: keybindings.json schema validation failed — using defaults',
    );
    return undefined;
  }

  // Check reserved keys across all contexts
  const overrides = result.data;
  for (const [ctx, bindings] of Object.entries(overrides)) {
    for (const key of Object.keys(bindings)) {
      try {
        assertNotReserved(key);
      } catch (err) {
        logger.warn(
          { ctx, key, err },
          '[SPEC-849] userOverrides: reserved key in keybindings.json — skipping context',
        );
        return undefined;
      }
    }
  }

  return overrides;
}
