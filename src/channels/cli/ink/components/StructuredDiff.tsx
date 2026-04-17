// StructuredDiff.tsx — SPEC-844: single-hunk unified diff renderer.
// Dashed top+bottom border (Claude Code FileEditToolDiff.tsx:98 pattern).
// Gutter: +/- marker + right-aligned line number, total ≤8 chars.
// WeakMap cache: callers must freeze/memoize hunk objects per toolUseId.
// Narrow fallback: cols - GUTTER_WIDTH < 40 → Fallback component.

import React from 'react';
import { Box, Text } from 'ink';
import { logger } from '../../../../observability/logger.ts';
import { useTheme, useThemeName } from '../theme.ts';
import type { DiffHunk, DiffLine } from './StructuredDiff/colorDiff.ts';
import { lineMarker, stripAnsiOsc } from './StructuredDiff/colorDiff.ts';
import { Fallback } from './StructuredDiff/Fallback.tsx';

export type { DiffHunk, DiffLine };

// ── Constants ─────────────────────────────────────────────────────────────────
// Gutter: 1 char marker + 1 space + up to 6 chars for line number = 8 total.
export const GUTTER_WIDTH = 8;
const NARROW_THRESHOLD = 40; // cols - GUTTER_WIDTH < 40 → narrow fallback

// ── WeakMap hunk cache ────────────────────────────────────────────────────────
// Keyed on hunk object identity. Callers must:
//   1. Freeze hunk objects: Object.freeze(hunk) + Object.freeze(hunk.lines) etc.
//   2. Memoize per toolUseId so the same reference is used on re-renders.
// If JSON.parse creates fresh objects each render, this cache always misses.
// Cache stores rendered ReactNode arrays for each hunk reference.
const hunkCache = new WeakMap<DiffHunk, React.ReactElement[]>();


// ── Props ─────────────────────────────────────────────────────────────────────
export interface StructuredDiffProps {
  hunk: DiffHunk;
  /** Terminal columns — defaults to process.stdout.columns ?? 80 */
  cols?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatLineNo(n: number | undefined, width: number): string {
  if (n === undefined) return ' '.repeat(width);
  const s = String(n);
  return s.padStart(width);
}

function buildLineElements(
  hunk: DiffHunk,
  noColor: boolean,
  getColor: (token: Parameters<typeof useTheme extends () => infer F ? F : never>[0]) => string,
): React.ReactElement[] {
  const LINE_NO_WIDTH = GUTTER_WIDTH - 2; // 2 chars for marker + space

  return hunk.lines.map((line, i) => {
    const marker = lineMarker(line.type);
    const safe = stripAnsiOsc(line.content);

    // Determine which line number to show: add→newLineNo, remove→oldLineNo, context→either
    const lineNo =
      line.type === 'add'
        ? line.newLineNo
        : line.type === 'remove'
          ? line.oldLineNo
          : (line.oldLineNo ?? line.newLineNo);

    const lineNoStr = formatLineNo(lineNo, LINE_NO_WIDTH);

    if (noColor) {
      return (
        <Text key={i}>
          {marker} {lineNoStr} {safe}
        </Text>
      );
    }

    // Determine the token for this line type
    const token =
      line.type === 'add'
        ? 'success'
        : line.type === 'remove'
          ? 'error'
          : 'inactive';

    const color = getColor(token as Parameters<ReturnType<typeof useTheme>>[0]);
    const colorProp = color !== '' ? color : undefined;

    return (
      <Text key={i} color={colorProp}>
        {marker} {lineNoStr} {safe}
      </Text>
    );
  });
}

// ── Main component ────────────────────────────────────────────────────────────
export function StructuredDiff({ hunk, cols }: StructuredDiffProps): React.ReactElement {
  const effectiveCols = cols ?? (typeof process !== 'undefined' ? (process.stdout.columns ?? 80) : 80);
  const getColor = useTheme();
  const themeName = useThemeName();
  const noColor = themeName === 'dark-ansi' || themeName === 'light-ansi';

  // Narrow fallback check (SPEC-844 §3: cols - GUTTER_WIDTH < 40)
  if (effectiveCols - GUTTER_WIDTH < NARROW_THRESHOLD) {
    return <Fallback hunk={hunk} />;
  }

  // WeakMap cache lookup
  let lineElements = hunkCache.get(hunk);
  if (lineElements === undefined) {
    logger.debug({ hunkStart: hunk.oldStart }, 'hunk cache miss');
    lineElements = buildLineElements(hunk, noColor, getColor);
    hunkCache.set(hunk, lineElements);
  }

  // Dashed top+bottom border — matches Claude Code FileEditToolDiff.tsx:98
  return (
    <Box
      borderStyle="classic"
      borderColor={noColor ? undefined : 'grey'}
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
      flexDirection="column"
    >
      {lineElements}
    </Box>
  );
}
