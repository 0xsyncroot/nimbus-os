// reservedShortcuts.ts — SPEC-849: Reserved key guard.
// ctrl+c and ctrl+d are hard-reserved — they cannot be rebound by user config.
// Attempting to override throws NimbusError(P_KEYBIND_RESERVED).

import { NimbusError, ErrorCode } from '../../../../observability/errors.ts';

// ── Reserved key set ───────────────────────────────────────────────────────────

const RESERVED_KEYS: ReadonlySet<string> = new Set(['ctrl+c', 'ctrl+d']);

/**
 * Returns true if the given key string is reserved and cannot be rebound.
 */
export function isReserved(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/**
 * Asserts that the key is not reserved.
 * Throws NimbusError(P_KEYBIND_RESERVED) if it is.
 */
export function assertNotReserved(key: string): void {
  if (isReserved(key)) {
    throw new NimbusError(ErrorCode.P_KEYBIND_RESERVED, {
      reason: 'keybind_reserved',
      key,
      hint: 'ctrl+c and ctrl+d are reserved and cannot be rebound',
    });
  }
}
