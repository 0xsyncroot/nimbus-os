// breakpoints.ts — SPEC-849: useBreakpoints() hook for responsive layout.
// Derives boolean flags from terminal cols via AppContext (SPEC-840).
// Thresholds: isCompact <120, isNarrow <80, isTight <60.
// No polling — SIGWINCH handled by Ink's useStdout() resize event upstream.

import { useAppContext } from './app.tsx';

// ── Breakpoints interface ──────────────────────────────────────────────────────

export interface Breakpoints {
  /** cols < 120: switch to single-column layouts */
  isCompact: boolean;
  /** cols < 80: hide secondary panels, shorten labels */
  isNarrow: boolean;
  /** cols < 60: minimal mode, icons only, truncate aggressively */
  isTight: boolean;
}

// ── Thresholds (exported for tests) ───────────────────────────────────────────

export const BP_COMPACT = 120;
export const BP_NARROW = 80;
export const BP_TIGHT = 60;

// ── Pure derivation helper ─────────────────────────────────────────────────────

export function deriveBreakpoints(cols: number): Breakpoints {
  return {
    isCompact: cols < BP_COMPACT,
    isNarrow: cols < BP_NARROW,
    isTight: cols < BP_TIGHT,
  };
}

// ── Hook ───────────────────────────────────────────────────────────────────────

/**
 * Returns breakpoint flags derived from the current terminal column count.
 * Layout-sensitive components consume this to degrade gracefully at smaller sizes.
 * Recalculates automatically on SIGWINCH (via Ink's resize event in AppContext).
 *
 * Must be called inside the <App> tree (requires AppContext from SPEC-840).
 */
export function useBreakpoints(): Breakpoints {
  const { cols } = useAppContext();
  return deriveBreakpoints(cols);
}
