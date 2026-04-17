// figures.ts — SPEC-843: Platform-aware glyph constants for Ink components.
// Exports TOOL_USE_GLYPH (⏺ darwin, ● elsewhere) and BULLET_GLYPH (● always).
// Uses the `figures` package (SPEC-840 dep) for cross-platform Unicode detection.

import figures from 'figures';

// ── Platform detection ─────────────────────────────────────────────────────────
const IS_DARWIN = process.platform === 'darwin';

/**
 * TOOL_USE_GLYPH — glyph shown in tool-use block header.
 *   ⏺  (U+23FA BLACK CIRCLE FOR RECORD) on macOS — matches Claude Code.
 *   ●  (U+25CF BLACK CIRCLE)            on Linux + Windows.
 */
export const TOOL_USE_GLYPH: string = IS_DARWIN ? '⏺' : '●';

/**
 * BULLET_GLYPH — used for status bullets and list items.
 * Always ● regardless of platform.
 */
export const BULLET_GLYPH: string = '●';

/**
 * TICK_GLYPH — success tick, delegates to `figures` for cross-platform safety.
 */
export const TICK_GLYPH: string = figures.tick;

/**
 * CROSS_GLYPH — failure cross, delegates to `figures`.
 */
export const CROSS_GLYPH: string = figures.cross;

/**
 * WARNING_GLYPH — warning triangle, delegates to `figures`.
 */
export const WARNING_GLYPH: string = figures.warning;

/**
 * POINTER_GLYPH — single right arrow pointer, delegates to `figures`.
 */
export const POINTER_GLYPH: string = figures.pointer;

/**
 * ELLIPSIS_GLYPH — ellipsis for truncation indicators.
 */
export const ELLIPSIS_GLYPH: string = figures.ellipsis;

// ── Spinner frame sets (SPEC-843 §3 Technical) ────────────────────────────────

/**
 * Ghostty terminal detection (TERM_PROGRAM === 'ghostty').
 * Ghostty uses * at frame index 2 (ASCII-safe variant).
 */
const IS_GHOSTTY = process.env['TERM_PROGRAM'] === 'ghostty';

/**
 * SPINNER_FRAMES — platform-specific frame array.
 *   ghostty: ['·','✢','✳','✶','✻','*']   (ASCII fallback at pos 2)
 *   darwin:  ['·','✢','✳','✶','✻','✽']
 *   linux+win: ['·','✢','*','✶','✻','✽'] (ASCII fallback at pos 2)
 */
export const SPINNER_FRAMES: readonly string[] = IS_GHOSTTY
  ? ['·', '✢', '✳', '✶', '✻', '*']
  : IS_DARWIN
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽'];

/**
 * SPINNER_FRAMES_PINGPONG — full ping-pong sequence:
 * [...frames, ...frames.slice(1, -1).reverse()].
 * Gives smooth looping without jump at seam.
 */
export const SPINNER_FRAMES_PINGPONG: readonly string[] = [
  ...SPINNER_FRAMES,
  ...SPINNER_FRAMES.slice(1, -1).reverse(),
];
