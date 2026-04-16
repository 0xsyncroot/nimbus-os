// colors.ts — SPEC-801 T1 + SPEC-822 T7 + SPEC-823 T1: ANSI color helpers with NO_COLOR + TTY detection.

const ESC = '\x1b[';

type ColorFn = (s: string) => string;

export function isColorEnabled(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '') return true;
  if (process.env['TERM'] === 'dumb') return false;
  if (typeof process.stdout.isTTY === 'boolean') return process.stdout.isTTY;
  return false;
}

function wrap(open: string, close: string): ColorFn {
  return (s: string) => (isColorEnabled() ? `${ESC}${open}${s}${ESC}${close}` : s);
}

export const colors = {
  ok: wrap('32m', '39m'),
  warn: wrap('33m', '39m'),
  err: wrap('31m', '39m'),
  info: wrap('36m', '39m'),
  dim: wrap('2m', '22m'),
  bold: wrap('1m', '22m'),
};

export const prefixes = {
  ok: '[OK]',
  warn: '[WARN]',
  err: '[ERROR]',
  ask: '[ASK]',
  tool: '[TOOL]',
  cost: '[COST]',
  spec: '[SPEC]',
  plan: '[PLAN]',
};

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function colorEnabled(): boolean {
  return isColorEnabled();
}

// ---------------------------------------------------------------------------
// SPEC-823 T1 — Earth-brown palette (nâu đất) for nimbus welcome screen.
// All constants resolve to '' when isColorEnabled() returns false, covering
// NO_COLOR, TERM=dumb, and non-TTY environments.
// ---------------------------------------------------------------------------

function earthColor(code: string): string {
  return isColorEnabled() ? `\x1b[${code}m` : '';
}

/** Deep earth brown — xterm-256 #94 */
export function EARTH_DEEP(): string { return earthColor('38;5;94'); }
/** Light earth/tan — xterm-256 #180 */
export function EARTH_LIGHT(): string { return earthColor('38;5;180'); }
/** Dim/muted brown — xterm-256 #58 */
export function EARTH_DIM(): string { return earthColor('38;5;58'); }
/** Gold/amber accent — xterm-256 #136 */
export function EARTH_GOLD(): string { return earthColor('38;5;136'); }
/** Bark/dark brown — xterm-256 #130 */
export function EARTH_BARK(): string { return earthColor('38;5;130'); }

// ---------------------------------------------------------------------------
// SPEC-822 T7 — Slash UI polish constants (reusable across slash + markdown)
// ---------------------------------------------------------------------------

/** Accent color — blue-ish (xterm-256: 39) */
export const ACCENT = '\x1b[38;5;39m';
/** Dim (faint text) */
export const DIM = '\x1b[2m';
/** Ghost text (italicised dim — used for inline hints, deferred v0.3.1) */
export const GHOST = '\x1b[2;3m';
/** Horizontal rule character */
export const RULE_CHAR = '─';
/** Reset all attributes */
export const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// SPEC-824 T2 — Layout threshold constants
// ---------------------------------------------------------------------------

/** Minimum columns for wide 2-column welcome layout (mascot + text side-by-side) */
export const LAYOUT_WIDE_MIN = 70;
