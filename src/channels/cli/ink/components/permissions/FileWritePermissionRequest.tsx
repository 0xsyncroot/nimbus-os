// FileWritePermissionRequest.tsx — SPEC-846: permission dialog for Write tool.
// Shows file path + byte count. Preview via stripAnsiOsc on first 20 lines (META-009 T22).

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.ts';
import { stripAnsiOsc } from '../StructuredDiff/colorDiff.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

const MAX_PREVIEW_LINES = 20;

export function FileWritePermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput } = props;
  const getColor = useTheme();
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;

  const filePath = typeof toolInput['path'] === 'string' ? toolInput['path'] : '(unknown)';
  const content = typeof toolInput['content'] === 'string' ? toolInput['content'] : '';
  const byteCount = new TextEncoder().encode(content).length;

  // Safe preview: strip ANSI/OSC, first 20 lines
  const stripped = stripAnsiOsc(content);
  const previewLines = stripped.split('\n').slice(0, MAX_PREVIEW_LINES);
  const truncated = stripped.split('\n').length > MAX_PREVIEW_LINES;

  return (
    <PermissionDialog {...props}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'File:'}</Text>
          <Text bold>{filePath}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Size:'}</Text>
          <Text>{`${byteCount} bytes`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color={inactiveProp} dimColor>{'Preview:'}</Text>
          {previewLines.map((line, i) => (
            <Text key={i} color={inactiveProp} dimColor>{line}</Text>
          ))}
          {truncated && (
            <Text color={inactiveProp} dimColor>{`… (${stripped.split('\n').length - MAX_PREVIEW_LINES} more lines)`}</Text>
          )}
        </Box>
      </Box>
    </PermissionDialog>
  );
}
