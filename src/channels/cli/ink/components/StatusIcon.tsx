// StatusIcon.tsx — SPEC-840: Status glyph using figures icons.
// Maps status → figures symbol → ThemedText with appropriate token.
// Falls back to ASCII chars if figures is unavailable.

import React from 'react';
import figures from 'figures';
import { ThemedText } from './ThemedText.tsx';
import type { ThemeToken } from '../theme.ts';

export type StatusKind = 'success' | 'pending' | 'inactive' | 'error' | 'warning';

export interface StatusIconProps {
  status: StatusKind;
}

interface StatusConfig {
  icon: string;
  token: ThemeToken;
}

const STATUS_MAP: Record<StatusKind, StatusConfig> = {
  success: { icon: figures.tick, token: 'success' },
  pending: { icon: figures.squareSmallFilled, token: 'suggestion' },
  inactive: { icon: figures.squareSmall, token: 'inactive' },
  error: { icon: figures.cross, token: 'error' },
  warning: { icon: figures.warning, token: 'warning' },
};

export function StatusIcon({ status }: StatusIconProps): React.ReactElement {
  const config = STATUS_MAP[status];
  return (
    <ThemedText token={config.token}>
      {config.icon}
    </ThemedText>
  );
}
