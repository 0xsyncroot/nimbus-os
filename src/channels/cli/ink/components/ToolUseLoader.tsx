// ToolUseLoader.tsx — SPEC-845: Progress indicator for long-running tools.
// Shows elapsed mm:ss counter alongside SpinnerWithVerb.
// Interval clears on unmount to prevent memory leaks.
// Max 1 loader visible (caller is responsible for stacking).

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { SpinnerWithVerb } from './SpinnerWithVerb.tsx';
import { useTheme } from '../theme.ts';
import { STALL_THRESHOLD_MS } from './SpinnerWithVerb.tsx';

// ── Props ─────────────────────────────────────────────────────────────────────
export interface ToolUseLoaderProps {
  /** Tool name shown as verb label (e.g. "Bash", "WebFetch"). */
  toolName: string;
  /** Date.now() timestamp captured when the tool started. */
  startedAt: number;
}

// ── Elapsed formatter ─────────────────────────────────────────────────────────

/**
 * formatElapsed — converts milliseconds to "mm:ss" string.
 * Examples: 5000 → "00:05", 65000 → "01:05", 3600000 → "60:00"
 */
export function formatElapsed(ms: number): string {
  const totalSecs = Math.floor(Math.max(0, ms) / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ToolUseLoader({
  toolName,
  startedAt,
}: ToolUseLoaderProps): React.ReactElement {
  const getColor = useTheme();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = now - startedAt;
  const elapsedSecs = elapsedMs / 1000;
  const isStalled = elapsedMs >= STALL_THRESHOLD_MS;

  return (
    <Box gap={1}>
      <SpinnerWithVerb
        verb={toolName}
        stalled={isStalled}
        stallSecs={elapsedSecs}
      />
      <Text color={getColor('inactive')}>{formatElapsed(elapsedMs)}</Text>
    </Box>
  );
}
