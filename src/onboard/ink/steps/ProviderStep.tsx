// ProviderStep.tsx — SPEC-855 T4: Provider selection via @inkjs/ui Select.
// Step 2/7: pick AI provider (Anthropic / OpenAI / Groq / DeepSeek / Ollama / custom).

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import type { StepProps } from './WelcomeStep.tsx';
import type { WizardAnswers } from '../Onboarding.tsx';

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'groq', label: 'Groq' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'ollama', label: 'Ollama (local, no key needed)' },
  { value: 'custom', label: 'Custom / vLLM / LiteLLM' },
] as const;

type ProviderValue = (typeof PROVIDER_OPTIONS)[number]['value'];

export function ProviderStep({ answers, onSubmit, onBack: _onBack }: StepProps): React.ReactElement {
  const [selected, setSelected] = useState<ProviderValue>(
    (answers.provider as ProviderValue | undefined) ?? 'anthropic',
  );

  // Select from @inkjs/ui handles arrow keys; Enter fires onChange with final value.
  // We handle onBack via a separate key listener via useInput in parent.

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Choose your AI provider</Text>
      <Select
        options={[...PROVIDER_OPTIONS]}
        defaultValue={selected}
        onChange={(value) => {
          const v = value as ProviderValue;
          setSelected(v);
          const patch: Partial<WizardAnswers> = { provider: v };
          // If provider changed, reset endpoint so EndpointStep re-resolves.
          if (v !== answers.provider) {
            patch.endpoint = undefined;
            patch.baseUrl = undefined;
          }
          onSubmit(patch);
        }}
      />
      <Text dimColor>↑ ↓ select  •  Enter confirm  •  Esc back</Text>
    </Box>
  );
}
