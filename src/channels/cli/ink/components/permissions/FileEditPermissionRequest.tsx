// FileEditPermissionRequest.tsx — SPEC-846: permission dialog for Edit tool.
// Embeds <StructuredDiff> inline (SPEC-844). Plan body stripped through stripAnsiOsc (META-009 T22).

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.ts';
import { stripAnsiOsc } from '../StructuredDiff/colorDiff.ts';
import { StructuredDiff } from '../StructuredDiff.tsx';
import type { DiffHunk } from '../StructuredDiff/colorDiff.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

export function FileEditPermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput } = props;
  const getColor = useTheme();
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;

  const filePath = typeof toolInput['path'] === 'string' ? toolInput['path'] : '(unknown)';

  // Accept pre-parsed DiffHunk from toolInput if available (passed by UIHost)
  const hunk = (toolInput['hunk'] as DiffHunk | undefined) ?? null;

  // Fallback: show old/new text as plain stripped preview
  const oldStr = typeof toolInput['old_string'] === 'string'
    ? stripAnsiOsc(toolInput['old_string'])
    : null;
  const newStr = typeof toolInput['new_string'] === 'string'
    ? stripAnsiOsc(toolInput['new_string'])
    : null;

  return (
    <PermissionDialog {...props}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'File:'}</Text>
          <Text bold>{filePath}</Text>
        </Box>
        {hunk !== null ? (
          <Box marginTop={1}>
            <StructuredDiff hunk={hunk} />
          </Box>
        ) : (
          oldStr !== null && newStr !== null && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={inactiveProp} dimColor>{'Old:'}</Text>
              <Text color={getColor('error') !== '' ? getColor('error') : undefined}>{`- ${oldStr.slice(0, 200)}`}</Text>
              <Text color={inactiveProp} dimColor>{'New:'}</Text>
              <Text color={getColor('success') !== '' ? getColor('success') : undefined}>{`+ ${newStr.slice(0, 200)}`}</Text>
            </Box>
          )
        )}
      </Box>
    </PermissionDialog>
  );
}
