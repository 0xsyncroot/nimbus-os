// SummaryStep.tsx — SPEC-855 T7: Final summary + confirm before workspace creation.
// Step 7/7: shows all collected answers; Enter = confirm, Esc = back.

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Pane } from '../../../channels/cli/ink/components/Pane.tsx';
import type { StepProps } from './WelcomeStep.tsx';

export function SummaryStep({ answers, onSubmit, onBack }: StepProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) onSubmit();
    if (key.escape) onBack();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Review your configuration</Text>
      <Pane title="Workspace setup">
        <Box flexDirection="column" paddingX={1} gap={0}>
          <Box gap={2}>
            <Text bold>Provider:</Text>
            <Text>{answers.provider ?? '—'}</Text>
          </Box>
          {answers.endpoint !== undefined && (
            <Box gap={2}>
              <Text bold>Endpoint:</Text>
              <Text>{answers.endpoint}</Text>
            </Box>
          )}
          {answers.baseUrl !== undefined && (
            <Box gap={2}>
              <Text bold>Base URL:</Text>
              <Text>{answers.baseUrl}</Text>
            </Box>
          )}
          <Box gap={2}>
            <Text bold>Model tier:</Text>
            <Text>{answers.modelClass ?? 'workhorse'}</Text>
          </Box>
          <Box gap={2}>
            <Text bold>Language:</Text>
            <Text>{answers.locale ?? 'en'}</Text>
          </Box>
          <Box gap={2}>
            <Text bold>API key:</Text>
            <Text>{answers.apiKey ? '(provided — will be stored securely)' : '(not set — configure later)'}</Text>
          </Box>
        </Box>
      </Pane>
      <Text dimColor>Press Enter to create workspace  •  Esc to go back</Text>
    </Box>
  );
}
