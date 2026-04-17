// DoctorModal.tsx — SPEC-847 T4: /doctor modal — renders CheckRow[] from doctor.ts.
// Memoizes runDoctorChecks() result for modal lifetime. 'r' key triggers re-run.
// Uses pure runDoctorChecks() (SPEC-847 T4 refactor) — does NOT write to stdout.

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import { runDoctorChecks, type CheckRow } from '../../../../../cli/debug/doctor.ts';
import type { ModalProps } from './types.ts';

// ── Status display ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CheckRow['status'] }): React.ReactElement {
  if (status === 'ok') return <Text color="green">OK  </Text>;
  if (status === 'warn') return <Text color="yellow">WARN</Text>;
  return <Text color="red">FAIL</Text>;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DoctorModal({ onClose }: ModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  const [checkRows, setCheckRows] = useState<CheckRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback((): void => {
    setRunning(true);
    void runDoctorChecks()
      .then((result) => {
        setCheckRows(result);
        setRunning(false);
      })
      .catch(() => {
        setCheckRows([{ label: 'Error', value: 'check failed', status: 'fail' }]);
        setRunning(false);
      });
  }, []);

  // Run once on mount — memoized for modal lifetime
  useEffect(() => {
    run();
  }, [run]);

  useInput((_input, key) => {
    if (key.escape || _input === 'q') { onClose(); return; }
    if (_input === 'r') { run(); return; }
  });

  const maxVisible = Math.max(1, rows - 5);
  const visible = (checkRows ?? []).slice(0, maxVisible);

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Doctor</ThemedText>
          {running && <Text dimColor> — running checks…</Text>}
        </Box>

        {/* Check rows */}
        <Box flexDirection="column" flexGrow={1} paddingX={2}>
          {checkRows === null ? (
            <Text dimColor>Loading…</Text>
          ) : (
            visible.map((cr, i) => (
              <Box key={i} flexDirection="row">
                <StatusBadge status={cr.status} />
                <Text>  </Text>
                <ThemedText token="suggestion">{cr.label.padEnd(20)}</ThemedText>
                <Text>{cr.value}</Text>
                {cr.detail !== undefined && (
                  <Text dimColor>{`  (${cr.detail})`}</Text>
                )}
              </Box>
            ))
          )}
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>r re-run  Esc / q close</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
