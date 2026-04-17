// SkillPermissionRequest.tsx — SPEC-846: permission dialog for Skill tool.
// Shows skill name + description.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

export function SkillPermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput } = props;
  const getColor = useTheme();
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;

  const skillName = typeof toolInput['name'] === 'string' ? toolInput['name'] : '(unknown)';
  const description = typeof toolInput['description'] === 'string' ? toolInput['description'] : '';

  return (
    <PermissionDialog {...props}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={inactiveProp}>{'Skill:'}</Text>
          <Text bold>{skillName}</Text>
        </Box>
        {description.length > 0 && (
          <Text color={inactiveProp} dimColor>{description}</Text>
        )}
      </Box>
    </PermissionDialog>
  );
}
