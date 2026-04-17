// WelcomeStep.tsx — SPEC-855 T2: Welcome banner + version display.
// Step 1/7: shows nimbus-os banner and version, user presses Enter to proceed.

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { WizardAnswers } from '../Onboarding.tsx';

export interface StepProps {
  answers: WizardAnswers;
  onSubmit: (patch?: Partial<WizardAnswers>) => void;
  onBack: () => void;
}

const VERSION = '0.3.21-alpha';

export function WelcomeStep({ onSubmit }: StepProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.return) onSubmit();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color="cyan">nimbus-os</Text>
        <Text dimColor>version {VERSION}</Text>
      </Box>
      <Text>Welcome! This wizard sets up your personal AI OS workspace.</Text>
      <Text>You will configure your AI provider, API key, model, and language.</Text>
      <Text dimColor>Press Enter to begin  •  Esc to go back  •  Ctrl-C to abort</Text>
    </Box>
  );
}
