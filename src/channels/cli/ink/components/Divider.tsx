// Divider.tsx — SPEC-840: Horizontal rule.
// Uses '─' (U+2500 BOX DRAWINGS LIGHT HORIZONTAL) drawn across terminal width.
// Falls back to ASCII '-' if unicode is disabled via NIMBUS_ASCII=1 env.

import React from 'react';
import { Box, Text } from 'ink';

export interface DividerProps {
  /** Width in columns (default: 40) */
  width?: number;
  /** Label rendered centred in the divider */
  label?: string;
  /** Force ASCII '-' instead of '─' */
  ascii?: boolean;
}

// Unicode box-drawing horizontal line (BOX DRAWINGS LIGHT HORIZONTAL)
const UNICODE_CHAR = '─';
const ASCII_CHAR = '-';

export function Divider({ width = 40, label, ascii = false }: DividerProps): React.ReactElement {
  const char = ascii ? ASCII_CHAR : UNICODE_CHAR;

  if (label === undefined) {
    return (
      <Box>
        <Text dimColor>{char.repeat(width)}</Text>
      </Box>
    );
  }

  const labelWithSpaces = ` ${label} `;
  const remaining = Math.max(0, width - labelWithSpaces.length);
  const leftLen = Math.floor(remaining / 2);
  const rightLen = remaining - leftLen;

  return (
    <Box>
      <Text dimColor>
        {char.repeat(leftLen)}
        {labelWithSpaces}
        {char.repeat(rightLen)}
      </Text>
    </Box>
  );
}
