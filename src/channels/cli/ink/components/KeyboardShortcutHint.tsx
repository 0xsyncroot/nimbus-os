// KeyboardShortcutHint.tsx — SPEC-840: Renders a [key] label pill.
// Minimal: shows the key binding in brackets followed by a description.
// Used across modals and status lines to surface keyboard shortcuts.

import React from 'react';
import { Box, Text } from 'ink';
import { ThemedText } from './ThemedText.tsx';

export interface KeyboardShortcutHintProps {
  /** The key or key combo (e.g. 'ctrl+c', 'enter', '?') */
  keyName: string;
  /** Human-readable description */
  label: string;
  /** Optional: rendered inline (default) or with extra margin */
  inline?: boolean;
}

export function KeyboardShortcutHint({
  keyName,
  label,
  inline = true,
}: KeyboardShortcutHintProps): React.ReactElement {
  return (
    <Box flexDirection="row" marginRight={inline ? 1 : 0}>
      <Text bold dimColor>{'['}</Text>
      <ThemedText token="suggestion" bold>
        {keyName}
      </ThemedText>
      <Text bold dimColor>{']'}</Text>
      <Text> </Text>
      <ThemedText token="inactive">{label}</ThemedText>
    </Box>
  );
}
