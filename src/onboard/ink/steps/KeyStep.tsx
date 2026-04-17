// KeyStep.tsx — SPEC-855 T3: API key entry via SPEC-841 PasswordPrompt.
// Step 4/7: masked key entry; Ollama is skipped by parent state machine.

import React from 'react';
import { Box, Text } from 'ink';
import { PasswordPrompt } from '../../../channels/cli/ink/components/PasswordPrompt.tsx';
import type { StepProps } from './WelcomeStep.tsx';

export function KeyStep({ answers, onSubmit }: StepProps): React.ReactElement {
  const label = `${answers.provider ?? 'provider'} API key:`;

  function handleSubmit(secret: string): void {
    if (secret.trim().length === 0) {
      // Empty accepted — user can set key later via `nimbus key set`.
      onSubmit({ apiKey: undefined });
    } else {
      onSubmit({ apiKey: secret.trim() });
    }
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Enter API Key</Text>
      <Text dimColor>
        Leave blank to skip — run <Text bold>nimbus key set {answers.provider ?? 'provider'}</Text> later.
      </Text>
      <PasswordPrompt
        label={label}
        placeholder="sk-…"
        onSubmit={handleSubmit}
      />
      <Text dimColor>Esc back  •  Ctrl-C abort + save draft</Text>
    </Box>
  );
}
