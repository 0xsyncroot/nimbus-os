// PermissionExplanation.tsx — SPEC-846: toggled explanation pane.
// Shows which path matched, which rule applied, why. Toggled via ctrl+e keybinding.
// Pure display component — toggle state managed by caller (or via usePermissionExplanation hook).

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme.ts';

export interface PermissionExplanationProps {
  /** Which rule matched (e.g. 'always-allow', 'confirm-on-write', 'deny-all') */
  matchedRule?: string;
  /** The path pattern that matched (e.g. '/home/user/projects/**') */
  matchedPath?: string;
  /** Human-readable explanation of why this rule applies */
  reason?: string;
  /** External toggle state — if provided, component is controlled */
  visible?: boolean;
  /** Callback when visibility changes (ctrl+e pressed) */
  onToggle?: (visible: boolean) => void;
}

/**
 * Hook to manage PermissionExplanation visibility + ctrl+e keybinding.
 * Use inside a component that wraps PermissionDialog.
 */
export function usePermissionExplanation(): {
  visible: boolean;
  toggle: () => void;
} {
  const [visible, setVisible] = useState(false);

  useInput((input, key) => {
    // ctrl+e toggles explanation pane
    if (key.ctrl && input === 'e') {
      setVisible((v) => !v);
    }
  });

  return { visible, toggle: () => setVisible((v) => !v) };
}

export function PermissionExplanation({
  matchedRule,
  matchedPath,
  reason,
  visible,
  onToggle,
}: PermissionExplanationProps): React.ReactElement {
  const [internalVisible, setInternalVisible] = useState(false);
  const getColor = useTheme();
  const permColor = getColor('permission');
  const colorProp = permColor !== '' ? permColor : undefined;
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;
  const subtleColor = getColor('subtle');
  const subtleProp = subtleColor !== '' ? subtleColor : undefined;

  // Support both controlled (visible prop) and uncontrolled modes
  const isVisible = visible !== undefined ? visible : internalVisible;

  useInput((input, key) => {
    if (key.ctrl && input === 'e') {
      const next = !isVisible;
      if (onToggle) {
        onToggle(next);
      } else {
        setInternalVisible(next);
      }
    }
  });

  if (!isVisible) {
    return (
      <Box>
        <Text color={subtleProp} dimColor>
          {'ctrl+e — explain why this permission is needed'}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colorProp}
      paddingX={1}
      paddingY={0}
      marginTop={1}
    >
      <Text color={colorProp} bold>{'Permission Explanation'}</Text>
      {matchedPath !== undefined && (
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Path matched:'}</Text>
          <Text>{matchedPath}</Text>
        </Box>
      )}
      {matchedRule !== undefined && (
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Rule applied:'}</Text>
          <Text>{matchedRule}</Text>
        </Box>
      )}
      {reason !== undefined && (
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Reason:'}</Text>
          <Text>{reason}</Text>
        </Box>
      )}
      {matchedPath === undefined && matchedRule === undefined && reason === undefined && (
        <Text color={inactiveProp} dimColor>{'No rule explanation available.'}</Text>
      )}
      <Text color={subtleProp} dimColor>{'ctrl+e — close explanation'}</Text>
    </Box>
  );
}
