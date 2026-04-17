// Fallback.tsx — SPEC-844: plain-text single-column diff renderer.
// Used when cols - GUTTER_WIDTH < 40 (narrow terminal) OR when NAPI is absent.
// No ANSI colors, no Ink Box border — just text with +/- markers.

import React from 'react';
import { Box, Text } from 'ink';
import type { DiffHunk } from './colorDiff.ts';
import { lineMarker, stripAnsiOsc } from './colorDiff.ts';

export interface FallbackProps {
  hunk: DiffHunk;
}

export function Fallback({ hunk }: FallbackProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {hunk.lines.map((line, i) => {
        const marker = lineMarker(line.type);
        const safe = stripAnsiOsc(line.content);
        return (
          <Text key={i}>
            {marker} {safe}
          </Text>
        );
      })}
    </Box>
  );
}
