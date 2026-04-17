// Pane.tsx — SPEC-840: <Box> wrapper with rounded border + optional title.
// Uses Ink's built-in border system; title rendered as Text overlay in the top bar.

import React from 'react';
import { Box, Text } from 'ink';

export interface PaneProps {
  title?: string;
  width?: number | string;
  height?: number;
  children?: React.ReactNode;
  /** Flex direction for the inner content box (default: 'column') */
  flexDirection?: 'row' | 'column';
}

export function Pane({
  title,
  width,
  height,
  children,
  flexDirection = 'column',
}: PaneProps): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      width={width}
      height={height}
    >
      {title !== undefined && (
        <Box paddingLeft={1} paddingRight={1}>
          <Text bold>{title}</Text>
        </Box>
      )}
      <Box flexDirection={flexDirection} flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
