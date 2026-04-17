// PermissionDialog.tsx — SPEC-846: shared shell for all permission dialogs.
// Border: borderStyle="round" borderLeft={false} borderRight={false} borderBottom={false}
// (pinned — matches Claude Code PermissionDialog.tsx:62).
// Permission color token from SPEC-840 theme. Title + optional byline + body + response row.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme.ts';

// ── Props ──────────────────────────────────────────────────────────────────────
export interface PermissionDialogProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  onAllow: () => void;
  onAlways: () => void;
  onDeny: () => void;
  setStickyFooter?: (node: React.ReactNode) => void;
  /** If false, "Yes, and don't ask again" is hidden (META-009 T23). */
  allowAlways?: boolean;
}

// ── Response option type ───────────────────────────────────────────────────────
type ResponseOption = 'allow' | 'always' | 'deny';

// ── Border constants (pinned per SPEC-846 §3 + Claude Code PermissionDialog.tsx:62) ──
export const PERMISSION_BORDER_STYLE = 'round' as const;
export const PERMISSION_BORDER_LEFT = false;
export const PERMISSION_BORDER_RIGHT = false;
export const PERMISSION_BORDER_BOTTOM = false;

// ── Component ──────────────────────────────────────────────────────────────────
export function PermissionDialog({
  toolName,
  toolInput: _toolInput,
  onAllow,
  onAlways,
  onDeny,
  setStickyFooter: _setStickyFooter,
  allowAlways = true,
  children,
}: PermissionDialogProps & { children?: React.ReactNode }): React.ReactElement {
  const getColor = useTheme();
  const permColor = getColor('permission');
  const colorProp = permColor !== '' ? permColor : undefined;

  const options: ResponseOption[] = allowAlways
    ? ['allow', 'always', 'deny']
    : ['allow', 'deny'];

  const [selectedIdx, setSelectedIdx] = useState(0);

  useInput((input, key) => {
    if (key.tab || key.rightArrow || key.downArrow) {
      setSelectedIdx((i) => (i + 1) % options.length);
    } else if (key.leftArrow || key.upArrow) {
      setSelectedIdx((i) => (i - 1 + options.length) % options.length);
    } else if (key.return) {
      const selected = options[selectedIdx];
      if (selected === 'allow') onAllow();
      else if (selected === 'always') onAlways();
      else onDeny();
    } else if (input === 'y' || input === 'Y') {
      onAllow();
    } else if (input === 'n' || input === 'N') {
      onDeny();
    } else if ((input === 'a' || input === 'A') && allowAlways) {
      onAlways();
    }
    // setStickyFooter is forwarded to ExitPlanModePermissionRequest; not used in base dialog
  });

  const responseRow = (
    <Box flexDirection="row" marginTop={1} gap={2}>
      {options.map((opt, i) => {
        const isSelected = i === selectedIdx;
        const label = opt === 'allow'
          ? 'Yes'
          : opt === 'deny'
            ? 'No'
            : `Yes, and don't ask again for ${toolName}`;
        return (
          <Text key={opt} color={isSelected ? colorProp : undefined} bold={isSelected}>
            {isSelected ? `[${label}]` : label}
          </Text>
        );
      })}
    </Box>
  );

  return (
    <Box
      borderStyle={PERMISSION_BORDER_STYLE}
      borderColor={colorProp}
      borderTop
      borderLeft={PERMISSION_BORDER_LEFT}
      borderRight={PERMISSION_BORDER_RIGHT}
      borderBottom={PERMISSION_BORDER_BOTTOM}
      flexDirection="column"
      paddingX={1}
      paddingBottom={1}
    >
      <Text color={colorProp} bold>
        {`nimbus wants to use ${toolName}`}
      </Text>
      {children !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
      )}
      {responseRow}
    </Box>
  );
}
