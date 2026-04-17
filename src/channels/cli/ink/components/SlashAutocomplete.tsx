// SlashAutocomplete.tsx — SPEC-842 T1: slash command dropdown overlay.
// Category grouping (session/workspace/model/system). Keys: ↑↓ nav, Tab accept
// with trailing space for arg, Enter run, Esc dismiss. Sibling subtree pattern.
// Empty '/' shows all commands; '/m' filters to matching.

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { ThemedText } from './ThemedText.tsx';
import { matchCommands, groupByCategory, CATEGORY_LABELS } from '../utils/commandSuggestions.ts';
import type { SlashCommand } from '../../slashCommands.ts';

// ── Props ────────────────────────────────────────────────────────────────────

export interface SlashAutocompleteProps {
  /** Current buffer content — must match ^\/\w*$ to render dropdown. */
  query: string;
  /** Called when user accepts a command (Tab / Enter). */
  onAccept: (command: string) => void;
  /** Called when user presses Esc or types outside /\w* pattern. */
  onDismiss: () => void;
}

// ── Max visible items ─────────────────────────────────────────────────────────
const MAX_VISIBLE = 8;

// ── Component ─────────────────────────────────────────────────────────────────

export function SlashAutocomplete({
  query,
  onAccept,
  onDismiss,
}: SlashAutocompleteProps): React.ReactElement | null {
  // Validate trigger pattern: must start with '/' followed by optional word chars
  if (!/^\/\w*$/.test(query)) return null;

  const searchTerm = query.slice(1); // strip leading '/'
  const matches = matchCommands(searchTerm);

  // Flatten grouped results for keyboard navigation
  const grouped = groupByCategory(matches);
  const flatCmds: SlashCommand[] = [];
  for (const cmds of grouped.values()) {
    for (const cmd of cmds) {
      flatCmds.push(cmd);
    }
  }

  const visible = flatCmds.slice(0, MAX_VISIBLE);

  const [cursorIndex, setCursorIndex] = useState(0);
  const safeCursor = Math.min(cursorIndex, Math.max(0, visible.length - 1));

  const acceptCurrent = useCallback(
    (withSpace: boolean) => {
      const cmd = visible[safeCursor];
      if (!cmd) return;
      onAccept('/' + cmd.name + (withSpace ? ' ' : ''));
    },
    [visible, safeCursor, onAccept],
  );

  useInput((_input, key) => {
    if (visible.length === 0) {
      if (key.escape) onDismiss();
      return;
    }

    if (key.upArrow) {
      setCursorIndex((prev) => (prev > 0 ? prev - 1 : visible.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursorIndex((prev) => (prev < visible.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.tab && !key.shift) {
      // Tab: accept highlighted command + trailing space for arg entry
      acceptCurrent(true);
      return;
    }
    if (key.return) {
      // Enter: accept highlighted command without trailing space
      acceptCurrent(false);
      return;
    }
    if (key.escape) {
      onDismiss();
      return;
    }
  });

  if (visible.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>No matching commands</Text>
      </Box>
    );
  }

  // Build render list with category headers
  const rows: React.ReactElement[] = [];
  let flatIdx = 0;
  for (const [cat, cmds] of grouped.entries()) {
    const label = CATEGORY_LABELS[cat] ?? cat;
    rows.push(
      <Box key={`cat:${cat}`} paddingLeft={1}>
        <ThemedText token="inactive" dimColor>
          {label.toUpperCase()}
        </ThemedText>
      </Box>,
    );
    for (const cmd of cmds) {
      if (flatIdx >= MAX_VISIBLE) break;
      const isSelected = flatIdx === safeCursor;
      const hint = cmd.argHint ? ` ${cmd.argHint}` : '';
      rows.push(
        <Box key={`cmd:${cmd.name}`} paddingX={1}>
          {isSelected ? (
            <Box>
              <ThemedText token="claude" bold>
                {'> '}
              </ThemedText>
              <ThemedText token="claude" bold>
                {`/${cmd.name}`}
              </ThemedText>
              <ThemedText token="suggestion">
                {hint}
              </ThemedText>
              <Text dimColor>{'  '}</Text>
              <ThemedText token="inactive">
                {cmd.description}
              </ThemedText>
            </Box>
          ) : (
            <Box>
              <Text>{'  '}</Text>
              <ThemedText token="text">
                {`/${cmd.name}`}
              </ThemedText>
              <ThemedText token="suggestion">
                {hint}
              </ThemedText>
              <Text dimColor>{'  '}</Text>
              <ThemedText token="inactive">
                {cmd.description}
              </ThemedText>
            </Box>
          )}
        </Box>,
      );
      flatIdx++;
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingY={0}>
      {rows}
      <Box paddingX={1} marginTop={0}>
        <Text dimColor>↑↓ navigate  Tab accept  Enter run  Esc dismiss</Text>
      </Box>
    </Box>
  );
}
