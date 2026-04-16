// mascot.ts — SPEC-824 T1: nimbus cloud + crescent moon mascot (5 rows × 13 cols).
// Uses CP437-safe block chars (░▒▓█▀▌·).
// Returns plain strings (no ANSI) when isColorEnabled() is false.

import { EARTH_DEEP, EARTH_DIM, EARTH_GOLD, EARTH_LIGHT, isColorEnabled } from './colors.ts';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Visible column width of the mascot block (ANSI-stripped). */
export const MASCOT_WIDTH = 13;

/** Number of rows returned by renderMascot(). */
export const MASCOT_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Internal helper: reset escape or empty string
// ---------------------------------------------------------------------------

function R(): string {
  return isColorEnabled() ? '\x1b[0m' : '';
}

// ---------------------------------------------------------------------------
// renderMascot — returns exactly MASCOT_HEIGHT colored lines.
// Each line's visible (ANSI-stripped) length is ≤ MASCOT_WIDTH.
//
// Pixel map (13 cols, using block-shade chars):
//   Row 0:    ░▒▓█▓▒░        → 7 chars, centred with 3 leading spaces
//   Row 1:   ▒████████▒      → 10 chars, centred with 2 leading spaces
//   Row 2:  ░██▓▓▓▓▓██▌░    → 12 chars, centred with 1 leading space
//   Row 3:   ▀█▓▓▓▓▓▀        → 8 chars, centred with 2 leading spaces + 3 trailing
//   Row 4:    ·  ·  ·         → 7 chars (visible), centred with 3 leading spaces
// ---------------------------------------------------------------------------

export function renderMascot(): string[] {
  if (!isColorEnabled()) {
    return [
      '   ░▒▓█▓▒░   ',
      '  ▒████████▒ ',
      ' ░██▓▓▓▓▓██▌░',
      '  ▀█▓▓▓▓▓▀   ',
      '   ·  ·  ·   ',
    ];
  }

  const L = EARTH_LIGHT();
  const G = EARTH_GOLD();
  const Dp = EARTH_DEEP();
  const Di = EARTH_DIM();
  const Rt = R();

  // Row 0: "   ░▒▓█▓▒░   " — all EARTH_LIGHT (13 visible)
  const row0 =
    `   ${L}░▒▓█▓▒░${Rt}   `;

  // Row 1: "  ▒████████▒ " — edges EARTH_LIGHT, fill EARTH_GOLD (13 visible)
  const row1 =
    `  ${L}▒${Rt}${G}████████${Rt}${L}▒${Rt} `;

  // Row 2: " ░██▓▓▓▓▓██▌░" — outer EARTH_LIGHT, mid EARTH_GOLD, inner EARTH_DEEP (13 visible)
  const row2 =
    ` ${L}░${Rt}${G}██${Rt}${Dp}▓▓▓${Rt}${G}██▌${Rt}${L}░${Rt}`;

  // Row 3: "  ▀█▓▓▓▓▓▀   " — EARTH_DEEP (13 visible)
  const row3 =
    `  ${Dp}▀█▓▓▓▓▓▀${Rt}   `;

  // Row 4: "   ·  ·  ·   " — EARTH_DIM (13 visible)
  const row4 =
    `   ${Di}·  ·  ·${Rt}   `;

  return [row0, row1, row2, row3, row4];
}
