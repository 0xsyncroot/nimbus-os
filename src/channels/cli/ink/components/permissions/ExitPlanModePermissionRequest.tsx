// ExitPlanModePermissionRequest.tsx — SPEC-846: permission dialog for ExitPlanMode tool.
// Sticky footer: Y/A/N options pinned via setStickyFooter prop; plan text scrolls above.
// Plan body routed through stripAnsiOsc — META-009 T22.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme.ts';
import { stripAnsiOsc } from '../StructuredDiff/colorDiff.ts';
import { PermissionDialog } from './PermissionDialog.tsx';
import type { PermissionDialogProps } from './PermissionDialog.tsx';

export function ExitPlanModePermissionRequest(props: PermissionDialogProps): React.ReactElement {
  const { toolInput, onAllow, onAlways, onDeny, setStickyFooter } = props;
  const getColor = useTheme();
  const permColor = getColor('permission');
  const colorProp = permColor !== '' ? permColor : undefined;
  const inactiveColor = getColor('inactive');
  const inactiveProp = inactiveColor !== '' ? inactiveColor : undefined;

  const rawPlan = typeof toolInput['plan'] === 'string' ? toolInput['plan'] : '';
  const plan = stripAnsiOsc(rawPlan);

  type ExitOption = 'allow' | 'always' | 'deny';
  const options: ExitOption[] = ['allow', 'always', 'deny'];
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
    } else if (input === 'y' || input === 'Y') onAllow();
    else if (input === 'a' || input === 'A') onAlways();
    else if (input === 'n' || input === 'N') onDeny();
  });

  // Sticky footer node — Y/A/N pinned
  const stickyFooterNode = (
    <Box flexDirection="row" gap={2} paddingX={1}>
      <Text color={selectedIdx === 0 ? colorProp : inactiveProp} bold={selectedIdx === 0}>
        {selectedIdx === 0 ? '[Y] Yes' : 'Y Yes'}
      </Text>
      <Text color={selectedIdx === 1 ? colorProp : inactiveProp} bold={selectedIdx === 1}>
        {selectedIdx === 1 ? '[A] Always' : 'A Always'}
      </Text>
      <Text color={selectedIdx === 2 ? colorProp : inactiveProp} bold={selectedIdx === 2}>
        {selectedIdx === 2 ? '[N] No' : 'N No'}
      </Text>
    </Box>
  );

  // Register sticky footer if setStickyFooter is provided
  if (setStickyFooter) {
    setStickyFooter(stickyFooterNode);
  }

  // Render plan body + embedded footer if no setStickyFooter
  return (
    <PermissionDialog {...props} allowAlways={true} onAllow={onAllow} onAlways={onAlways} onDeny={onDeny}>
      <Box flexDirection="column">
        {plan.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color={inactiveProp} dimColor>{'Plan:'}</Text>
            {plan.split('\n').map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
        {setStickyFooter === undefined && stickyFooterNode}
      </Box>
    </PermissionDialog>
  );
}
