// HelpModal.tsx — SPEC-847 T1: /help modal with AltScreen takeover.
// Wraps <HelpOverlay> from SPEC-842 inside <AltScreen> (SPEC-849).
// Half-height: maxHeight = Math.floor(rows / 2) enforced via Box height.
// ESC / q / ctrl+c exit and restore main screen via AltScreen cleanup.

import React from 'react';
import { Box, useStdout } from 'ink';
import { AltScreen } from '../../altScreen.tsx';
import { HelpOverlay } from '../HelpOverlay.tsx';
import type { ModalProps } from './types.ts';

/**
 * /help modal — 3-tab layout (Commands / General / Keybindings).
 * Uses half-terminal height per Claude Code HelpV2.tsx:20 pattern.
 */
export function HelpModal({ onClose }: ModalProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const maxHeight = Math.floor(rows / 2);

  return (
    <AltScreen rows={maxHeight}>
      <Box flexDirection="column" height={maxHeight} width="100%">
        <HelpOverlay onClose={onClose} />
      </Box>
    </AltScreen>
  );
}
