// PromptInputFooter.tsx — SPEC-848: Row below PromptInput.
// Contains mode badge, permission-mode symbol, and notification count.
// Degrades gracefully at narrow (cols < 80) and short (fullscreen + rows < 24) breakpoints.
// NOTE: SPEC-849 useBreakpoints not yet shipped; breakpoint logic is inlined here.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.ts';
import { getModeColor } from '../theme/modeColor.ts';
import type { PermissionMode } from '../../../../permissions/mode.ts';

// ── Breakpoint thresholds (inlined pending SPEC-849 useBreakpoints) ────────────
export const NARROW_COLS = 80;
export const SHORT_ROWS = 24;

/** Permission mode → concise symbol for the footer symbol slot. */
function getModeSymbol(mode: PermissionMode): string {
  switch (mode) {
    case 'readonly':
      return '🔒';
    case 'bypass':
      return '⚡';
    case 'plan':
      return '📋';
    case 'acceptEdits':
      return '✏️';
    case 'isolated':
      return '🔬';
    case 'default':
    default:
      return '●';
  }
}

export interface PromptInputFooterProps {
  mode: PermissionMode;
  /** True when terminal width < NARROW_COLS (80). */
  isNarrow: boolean;
  /** True when fullscreen and terminal height < SHORT_ROWS (24). */
  isShort: boolean;
  /** Number of pending notifications. */
  notificationCount: number;
}

/**
 * PromptInputFooter — rendered below the prompt input box.
 * - Always shows: mode badge + permission symbol.
 * - isNarrow: hides notification count label; shows compact badge.
 * - isShort: hides the entire footer bar (only badge survives).
 */
export function PromptInputFooter({
  mode,
  isNarrow,
  isShort,
  notificationCount,
}: PromptInputFooterProps): React.ReactElement {
  const getColor = useTheme();

  const modeToken = getModeColor(mode);
  const modeColor = getColor(modeToken);
  const modeColorProp = modeColor !== '' ? modeColor : undefined;

  const subtleColor = getColor('subtle');
  const subtleColorProp = subtleColor !== '' ? subtleColor : undefined;

  // In short mode show only the most critical info: mode badge.
  if (isShort) {
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={modeColorProp} bold>
          {mode}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" gap={1}>
      {/* Connector glyph — visually ties this row to the PromptInput box above */}
      <Text color={subtleColorProp}>{'╰'}</Text>

      {/* Mode badge */}
      <Text color={modeColorProp} bold>
        {mode}
      </Text>

      {/* Permission-mode symbol */}
      <Text color={subtleColorProp}>{getModeSymbol(mode)}</Text>

      {/* Notification count — hidden in narrow mode */}
      {!isNarrow && notificationCount > 0 ? (
        <Text color={getColor('warning') !== '' ? getColor('warning') : undefined}>
          {`[${notificationCount} notification${notificationCount === 1 ? '' : 's'}]`}
        </Text>
      ) : null}
    </Box>
  );
}
