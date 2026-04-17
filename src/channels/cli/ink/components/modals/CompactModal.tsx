// CompactModal.tsx — SPEC-847 T5: /compact modal — summary preview before compaction.
// Shows compact summary text. Confirm applies; Cancel dismisses without change.

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import type { ModalProps } from './types.ts';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface CompactModalProps extends ModalProps {
  summary: string;
  onConfirm: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function CompactModal({ summary, onConfirm, onClose }: CompactModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  useInput((_input, key) => {
    if (key.escape || _input === 'n' || _input === 'q') { onClose(); return; }
    if (_input === 'y' || key.return) {
      onConfirm();
      onClose();
      return;
    }
  });

  const summaryLines = summary.split('\n');
  const maxContent = Math.max(1, rows - 8);
  const visible = summaryLines.slice(0, maxContent);

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Compact Preview</ThemedText>
          <Text dimColor> — apply compaction?</Text>
        </Box>

        {/* Summary preview */}
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          {visible.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {summaryLines.length > maxContent && (
            <Text dimColor>{`… ${summaryLines.length - maxContent} more lines`}</Text>
          )}
        </Box>

        {/* Confirm / Cancel */}
        <Box paddingX={2} marginBottom={1}>
          <ThemedText token="success" bold>[y] Confirm</ThemedText>
          <Text>  </Text>
          <ThemedText token="error">[n/Esc] Cancel</ThemedText>
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>y / Enter confirm  n / Esc cancel</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
