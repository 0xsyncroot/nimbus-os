// EndpointStep.tsx — SPEC-855: Endpoint pick (only shown for non-Anthropic providers).
// Step 3/7: pick endpoint target; skipped automatically if provider = anthropic.

import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import type { StepProps } from './WelcomeStep.tsx';
import type { WizardAnswers } from '../Onboarding.tsx';

const ENDPOINT_OPTIONS = [
  { value: 'openai', label: 'OpenAI (api.openai.com/v1)' },
  { value: 'groq', label: 'Groq (api.groq.com/openai/v1)' },
  { value: 'deepseek', label: 'DeepSeek (api.deepseek.com/v1)' },
  { value: 'ollama', label: 'Ollama (localhost:11434)' },
  { value: 'gemini', label: 'Gemini AI Studio' },
  { value: 'custom', label: 'Custom base URL' },
] as const;

type EndpointValue = (typeof ENDPOINT_OPTIONS)[number]['value'];

function inferDefault(provider: string | undefined): EndpointValue {
  if (provider === 'openai') return 'openai';
  if (provider === 'groq') return 'groq';
  if (provider === 'deepseek') return 'deepseek';
  if (provider === 'ollama') return 'ollama';
  if (provider === 'gemini') return 'gemini';
  return 'openai';
}

export function EndpointStep({ answers, onSubmit }: StepProps): React.ReactElement {
  const defaultEndpoint = inferDefault(answers.provider);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select endpoint for {answers.provider ?? 'provider'}</Text>
      <Select
        options={[...ENDPOINT_OPTIONS]}
        defaultValue={defaultEndpoint}
        onChange={(value) => {
          const patch: Partial<WizardAnswers> = {
            endpoint: value as EndpointValue,
          };
          onSubmit(patch);
        }}
      />
      <Text dimColor>↑ ↓ select  •  Enter confirm  •  Esc back</Text>
    </Box>
  );
}
