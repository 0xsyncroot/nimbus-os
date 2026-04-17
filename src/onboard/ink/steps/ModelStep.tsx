// ModelStep.tsx — SPEC-855 T5: Model class selection per provider.
// Step 5/7: flagship / workhorse / budget, with provider-specific model names shown.

import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import type { StepProps } from './WelcomeStep.tsx';

interface ModelOption {
  value: 'flagship' | 'workhorse' | 'budget';
  label: string;
}

function modelOptions(provider: string | undefined): ModelOption[] {
  if (provider === 'anthropic') {
    return [
      { value: 'flagship', label: 'Flagship — claude-opus-4-6' },
      { value: 'workhorse', label: 'Workhorse — claude-sonnet-4-6 (recommended)' },
      { value: 'budget', label: 'Budget — claude-haiku-4-5' },
    ];
  }
  if (provider === 'openai') {
    return [
      { value: 'flagship', label: 'Flagship — gpt-4o' },
      { value: 'workhorse', label: 'Workhorse — gpt-5.4-mini (recommended)' },
      { value: 'budget', label: 'Budget — gpt-5.4-mini' },
    ];
  }
  return [
    { value: 'flagship', label: 'Flagship (best quality)' },
    { value: 'workhorse', label: 'Workhorse (recommended)' },
    { value: 'budget', label: 'Budget (fastest/cheapest)' },
  ];
}

export function ModelStep({ answers, onSubmit }: StepProps): React.ReactElement {
  const options = modelOptions(answers.provider);
  const defaultValue = answers.modelClass ?? 'workhorse';

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select model tier</Text>
      <Select
        options={options}
        defaultValue={defaultValue}
        onChange={(value) => {
          onSubmit({ modelClass: value as 'flagship' | 'workhorse' | 'budget' });
        }}
      />
      <Text dimColor>↑ ↓ select  •  Enter confirm  •  Esc back</Text>
    </Box>
  );
}
