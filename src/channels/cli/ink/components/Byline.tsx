// Byline.tsx — SPEC-840: Small dim subtitle rendered under a title.
// Uses 'inactive' ThemeToken for the dim appearance.

import React from 'react';
import { ThemedText } from './ThemedText.tsx';

export interface BylineProps {
  children: React.ReactNode;
}

export function Byline({ children }: BylineProps): React.ReactElement {
  return (
    <ThemedText token="inactive" dimColor>
      {children}
    </ThemedText>
  );
}
