// ThemedText.tsx — SPEC-840: <Text> wrapper consuming useTheme(), accepts token: ThemeToken.
// When NO_COLOR is active, useTheme() returns '' → color prop omitted → plain text.

import React from 'react';
import { Text } from 'ink';
import type { ThemeToken } from '../theme.ts';
import { useTheme } from '../theme.ts';

export interface ThemedTextProps {
  token: ThemeToken;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dimColor?: boolean;
  wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
  children?: React.ReactNode;
}

export function ThemedText({
  token,
  bold,
  italic,
  underline,
  dimColor,
  wrap,
  children,
}: ThemedTextProps): React.ReactElement {
  const getColor = useTheme();
  const color = getColor(token);

  // When color is empty string (ANSI/NO_COLOR palettes), omit the color prop
  // so Ink renders plain text without any escape sequences.
  const colorProp = color !== '' ? color : undefined;

  return (
    <Text
      color={colorProp}
      bold={bold}
      italic={italic}
      underline={underline}
      dimColor={dimColor}
      wrap={wrap}
    >
      {children}
    </Text>
  );
}
