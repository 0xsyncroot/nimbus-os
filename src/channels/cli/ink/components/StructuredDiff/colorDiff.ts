// colorDiff.ts — SPEC-844: syntax-aware colorizer for unified diff lines.
// MVP: no syntax highlight; + = success (green), - = error (red), context = inactive.
// NAPI absence: try/require guard (future-proof for compiled binary on Alpine/musl).
// NO_COLOR: caller passes noColor=true → plain +/- chars only, no ANSI tokens.

import type { ThemePalette } from '../../theme.ts';

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: DiffLine[];
}

// ── NAPI detection (future-proof) ─────────────────────────────────────────────
// If a native color-diff NAPI module is added later, try-require it here.
// For v0.4 MVP, pure-TS path only.
let _napiAvailable = false;
try {
  // Placeholder: no NAPI module yet. This pattern lets the binary degrade
  // gracefully on Alpine/musl/Windows where NAPI modules may be absent.
  // require('@nimbus-os/color-diff-napi'); // uncomment when module exists
  _napiAvailable = false;
} catch {
  _napiAvailable = false;
}

export function isNapiAvailable(): boolean {
  return _napiAvailable;
}

/**
 * Map a DiffLine type to the ThemePalette token key for coloring.
 * Returns the ANSI-safe color string from the palette, or empty string if NO_COLOR.
 */
export function colorize(line: DiffLine, noColor: boolean, palette?: ThemePalette): string {
  if (noColor || palette === undefined) {
    // Plain marker with no ANSI: return just the marker prefix
    return lineMarker(line.type);
  }

  // v0.4 MVP: token-less coloring — + green, - red, context dim
  switch (line.type) {
    case 'add':
      return palette.success;
    case 'remove':
      return palette.error;
    case 'context':
      return palette.inactive;
  }
}

/**
 * Returns the single-char gutter marker for a diff line type.
 */
export function lineMarker(type: DiffLine['type']): string {
  switch (type) {
    case 'add':     return '+';
    case 'remove':  return '-';
    case 'context': return ' ';
  }
}

// ── ANSI-OSC stripping ────────────────────────────────────────────────────────
// Diff content comes from Write/Edit tool output which may contain user-controlled text.
// TODO(SPEC-843): consolidate with Markdown.tsx stripAnsiOsc when that helper exists.
const ANSI_OSC_RE = /(\x9B|\x1B\[)[0-9;]*[ -/]*[@-~]|\x1B[^[\x1B]*(?:\x1B|$)|\x07|\x9C/g;

export function stripAnsiOsc(text: string): string {
  return text.replace(ANSI_OSC_RE, '');
}
