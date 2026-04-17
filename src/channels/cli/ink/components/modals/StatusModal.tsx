// StatusModal.tsx — SPEC-847 T4: /status modal — session info panel.
// Displays: version, session id/name, cwd, account, model, workspace.
// Read-only summary. No network calls.

import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { ThemedText } from '../ThemedText.tsx';
import type { ModalProps } from './types.ts';

// ── Props ──────────────────────────────────────────────────────────────────────

export interface StatusModalProps extends ModalProps {
  version: string;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  workspaceId: string;
  workspaceName: string;
  model: string;
  provider: string;
  sandboxEnabled: boolean;
}

// ── Row helper ──────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row" paddingX={2}>
      <ThemedText token="inactive">{label.padEnd(20)}</ThemedText>
      <ThemedText token="text">{value}</ThemedText>
    </Box>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function StatusModal({
  version,
  sessionId,
  sessionName,
  cwd,
  workspaceId,
  workspaceName,
  model,
  provider,
  sandboxEnabled,
  onClose,
}: StatusModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  useInput((_input, key) => {
    if (key.escape || _input === 'q') { onClose(); }
  });

  const sessionLabel = sessionName != null ? `${sessionId} (${sessionName})` : sessionId;

  return (
    <AltScreen>
      <Box flexDirection="column" width="100%" height={rows}>
        {/* Header */}
        <Box paddingX={2} paddingY={1}>
          <ThemedText token="claude" bold>Status</ThemedText>
        </Box>

        {/* Info rows */}
        <Box flexDirection="column" flexGrow={1}>
          <Row label="nimbus version" value={`v${version}`} />
          <Row label="Session" value={sessionLabel} />
          <Row label="Working dir" value={cwd} />
          <Row label="Workspace" value={`${workspaceName} (${workspaceId.slice(0, 8)}…)`} />
          <Row label="Model" value={model} />
          <Row label="Provider" value={provider} />
          <Row label="Sandbox" value={sandboxEnabled ? 'enabled' : 'disabled'} />
        </Box>

        {/* Footer */}
        <Box paddingX={2}>
          <Text dimColor>Esc / q close</Text>
        </Box>
      </Box>
    </AltScreen>
  );
}
