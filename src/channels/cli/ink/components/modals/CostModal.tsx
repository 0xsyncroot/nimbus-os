// CostModal.tsx — SPEC-847 T3: /cost modal with today/week/month table.
// Data from src/cost/dashboard.ts (showCost). NO sparkline for v0.4.0 (deferred).
// ESC / q exit and restore main screen.

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import { showCost } from '../../../../../cost/dashboard.ts';
import type { ModalProps } from './types.ts';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface CostModalProps extends ModalProps {
  workspaceId: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function CostModal({ workspaceId, onClose }: CostModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  const [todayText, setTodayText] = useState('Loading…');
  const [weekText, setWeekText] = useState('Loading…');
  const [monthText, setMonthText] = useState('Loading…');

  useEffect(() => {
    void showCost(workspaceId, { window: 'today' }).then(setTodayText).catch(() => setTodayText('(error)'));
    void showCost(workspaceId, { window: 'week' }).then(setWeekText).catch(() => setWeekText('(error)'));
    void showCost(workspaceId, { window: 'month' }).then(setMonthText).catch(() => setMonthText('(error)'));
  }, [workspaceId]);

  useInput((_input, key) => {
    if (key.escape || _input === 'q') { onClose(); }
  });

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Cost Dashboard</ThemedText>
        </Box>

        {/* Cost buckets */}
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          <Box marginBottom={1}>
            <ThemedText token="suggestion" bold>Today</ThemedText>
          </Box>
          <Box marginBottom={1} paddingLeft={2}>
            <Text>{todayText}</Text>
          </Box>

          <Box marginBottom={1}>
            <ThemedText token="suggestion" bold>Last 7 days</ThemedText>
          </Box>
          <Box marginBottom={1} paddingLeft={2}>
            <Text>{weekText}</Text>
          </Box>

          <Box marginBottom={1}>
            <ThemedText token="suggestion" bold>Last 30 days</ThemedText>
          </Box>
          <Box paddingLeft={2}>
            <Text>{monthText}</Text>
          </Box>
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>Esc / q close</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
