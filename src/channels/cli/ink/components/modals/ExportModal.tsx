// ExportModal.tsx — SPEC-847 T5: /export modal — filename input + format picker.
// Targets: file (default) or clipboard (OSC 52 deferred to v0.5).
// Uses @inkjs/ui TextInput for filename entry.

import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { TextInput } from '@inkjs/ui';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import type { ModalProps } from './types.ts';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface ExportModalProps extends ModalProps {
  defaultFilename?: string;
  onExport: (filename: string, format: ExportFormat) => void;
}

export type ExportFormat = 'markdown' | 'json';

const FORMATS: readonly ExportFormat[] = ['markdown', 'json'];

// ── Component ──────────────────────────────────────────────────────────────────

export function ExportModal({
  defaultFilename = 'session-export.md',
  onExport,
  onClose,
}: ExportModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  const [filename, setFilename] = useState(defaultFilename);
  const [formatIdx, setFormatIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useInput((_input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.leftArrow) {
      setFormatIdx((prev) => (prev > 0 ? prev - 1 : FORMATS.length - 1));
      return;
    }
    if (key.rightArrow) {
      setFormatIdx((prev) => (prev < FORMATS.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.return && !submitting) {
      const fmt = FORMATS[formatIdx] ?? 'markdown';
      setSubmitting(true);
      onExport(filename, fmt);
      onClose();
      return;
    }
  });

  const currentFormat = FORMATS[formatIdx] ?? 'markdown';

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Export Session</ThemedText>
        </Box>

        {/* Filename input */}
        <Box flexDirection="column" paddingX={2} marginBottom={1}>
          <ThemedText token="inactive">Filename:</ThemedText>
          <Box marginTop={1}>
            <TextInput
              placeholder="session-export.md"
              onChange={setFilename}
            />
          </Box>
        </Box>

        {/* Format picker */}
        <Box paddingX={2} marginBottom={1}>
          <ThemedText token="inactive">{'Format: '}</ThemedText>
          {FORMATS.map((fmt, idx) => (
            <Box key={fmt} marginRight={2}>
              {idx === formatIdx ? (
                <ThemedText token="claude" bold>{`[${fmt}]`}</ThemedText>
              ) : (
                <ThemedText token="inactive">{fmt}</ThemedText>
              )}
            </Box>
          ))}
        </Box>

        <Box flexGrow={1} />

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>
            {`← → format  Enter export as ${currentFormat}  Esc cancel`}
          </Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
