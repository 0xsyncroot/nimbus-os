// PasswordPrompt.tsx — SPEC-841: Password input wrapper.
// HARD RULE §10: MANDATORY use of @inkjs/ui PasswordInput.
// Paste applies mask BEFORE render; raw clipboard bytes never written to stdout.
// No new code path may bypass PasswordInput for secret/key prompts.

import React from 'react';
import { Box, Text } from 'ink';
import { PasswordInput } from '@inkjs/ui';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PasswordPromptProps {
  label: string;
  placeholder?: string;
  onSubmit: (secret: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PasswordPrompt({
  label,
  placeholder = 'Enter secret…',
  onSubmit,
}: PasswordPromptProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold>{label}</Text>
      <PasswordInput
        placeholder={placeholder}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
