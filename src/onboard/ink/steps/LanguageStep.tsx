// LanguageStep.tsx — SPEC-855 T5: Language selection (en / vi).
// Step 6/7: persists locale preference to workspace config.

import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import type { StepProps } from './WelcomeStep.tsx';

const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'vi', label: 'Tiếng Việt' },
] as const;

export function LanguageStep({ answers, onSubmit }: StepProps): React.ReactElement {
  const defaultValue = answers.locale ?? 'en';

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select language</Text>
      <Select
        options={[...LANG_OPTIONS]}
        defaultValue={defaultValue}
        onChange={(value) => {
          onSubmit({ locale: value as 'en' | 'vi' });
        }}
      />
      <Text dimColor>↑ ↓ select  •  Enter confirm  •  Esc back</Text>
    </Box>
  );
}
