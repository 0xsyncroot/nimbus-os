// WebFetchPermissionRequest.tsx — SPEC-846: permission dialog for WebFetch tool.
// URL preview with domain highlight. ANSI-OSC strip applied (META-009 T22).

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.ts';
import { stripAnsiOsc } from '../StructuredDiff/colorDiff.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function WebFetchPermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput } = props;
  const getColor = useTheme();
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;
  const ideColor = getColor('ide');
  const ideProp = ideColor !== '' ? ideColor : undefined;

  const rawUrl = typeof toolInput['url'] === 'string' ? toolInput['url'] : '(unknown)';
  const url = stripAnsiOsc(rawUrl);
  const domain = extractDomain(url);

  return (
    <PermissionDialog {...props}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Domain:'}</Text>
          <Text color={ideProp} bold>{domain}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'URL:'}</Text>
          <Text wrap="truncate-end">{url}</Text>
        </Box>
      </Box>
    </PermissionDialog>
  );
}
