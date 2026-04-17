// StructuredDiffList.tsx — SPEC-844: wraps multiple hunks for MultiEdit tool output.
// Renders each hunk in its own dashed frame with a hunk header (@@ -N,M +N,M @@).
// Callers must memoize hunk array elements per toolUseId for WeakMap cache hits.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme, useThemeName } from '../theme.ts';
import { StructuredDiff } from './StructuredDiff.tsx';
import type { DiffHunk } from './StructuredDiff/colorDiff.ts';

export interface StructuredDiffListProps {
  /** Absolute or relative file path — display only, never resolved. */
  filePath: string;
  hunks: DiffHunk[];
  /** Terminal columns — defaults to process.stdout.columns ?? 80 */
  cols?: number;
}

function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

export function StructuredDiffList({
  filePath,
  hunks,
  cols,
}: StructuredDiffListProps): React.ReactElement {
  const getColor = useTheme();
  const themeName = useThemeName();
  const noColor = themeName === 'dark-ansi' || themeName === 'light-ansi';

  const fileColor = noColor ? undefined : getColor('ide');

  return (
    <Box flexDirection="column">
      {/* File path header */}
      <Text color={fileColor !== '' ? fileColor : undefined} bold>
        {filePath}
      </Text>

      {/* Each hunk gets its own dashed frame + header */}
      {hunks.map((hunk, i) => (
        <Box key={i} flexDirection="column">
          <Text color={noColor ? undefined : (getColor('inactive') || undefined)}>
            {hunkHeader(hunk)}
          </Text>
          <StructuredDiff hunk={hunk} cols={cols} />
        </Box>
      ))}
    </Box>
  );
}
