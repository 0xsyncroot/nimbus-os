// StatusLine.tsx — SPEC-848: Single bottom status row.
// Layout: workspace · model · mode_badge · $today · ctx%
// Re-renders on AppContext change (SIGWINCH updates cols/rows via useTerminalSize in app.tsx).
// Cost + context % debounced at STATUS_DEBOUNCE_MS=300ms to prevent excessive re-renders.
// v0.4: NO shell-hook command execution (SPEC-848 §3 explicit decision; re-open v0.5).

import React, { useRef, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useAppContext } from '../app.tsx';
import { useTheme } from '../theme.ts';
import { getModeColor } from '../theme/modeColor.ts';

/** Debounce window for cost + context updates (ms). */
export const STATUS_DEBOUNCE_MS = 300;

/** Props injected from outside for cost/context data (avoids importing cost module directly). */
export interface StatusLineProps {
  /** Total cost today in USD. */
  costToday: number;
  /** Context window percentage used (0–100). */
  ctxPercent: number;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function formatCtx(pct: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return `${clamped}%`;
}

/**
 * StatusLine — renders workspace · model · mode · $today · ctx% in a single row.
 * Cost and ctx% updates are debounced at STATUS_DEBOUNCE_MS to prevent render churn.
 */
export function StatusLine({ costToday, ctxPercent }: StatusLineProps): React.ReactElement {
  const { workspace, mode, cols } = useAppContext();
  const getColor = useTheme();

  // ── Debounced cost + ctx state ─────────────────────────────────────────────
  const [displayCost, setDisplayCost] = useState<number>(costToday);
  const [displayCtx, setDisplayCtx] = useState<number>(ctxPercent);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDisplayCost(costToday);
      setDisplayCtx(ctxPercent);
      debounceTimerRef.current = null;
    }, STATUS_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [costToday, ctxPercent]);

  // ── Mode badge color ───────────────────────────────────────────────────────
  const modeToken = getModeColor(mode);
  const modeColor = getColor(modeToken);
  const modeColorProp = modeColor !== '' ? modeColor : undefined;

  // ── Separator ─────────────────────────────────────────────────────────────
  const sep = (
    <Text color={getColor('subtle') !== '' ? getColor('subtle') : undefined} dimColor>
      {' · '}
    </Text>
  );

  // ── Truncate model name on narrow terminals ────────────────────────────────
  const modelName =
    cols < 80
      ? workspace.defaultModel.split('-').slice(0, 2).join('-')
      : workspace.defaultModel;

  return (
    <Box flexDirection="row" width={cols}>
      {/* workspace name */}
      <Text color={getColor('claude') !== '' ? getColor('claude') : undefined}>
        {workspace.name}
      </Text>

      {sep}

      {/* model */}
      <Text color={getColor('inactive') !== '' ? getColor('inactive') : undefined} dimColor>
        {modelName}
      </Text>

      {sep}

      {/* mode badge */}
      <Text color={modeColorProp} bold>
        {mode}
      </Text>

      {sep}

      {/* cost today */}
      <Text color={getColor('text') !== '' ? getColor('text') : undefined}>
        {formatCost(displayCost)}
      </Text>

      {sep}

      {/* ctx% */}
      <Text
        color={
          displayCtx >= 80
            ? (getColor('error') !== '' ? getColor('error') : undefined)
            : displayCtx >= 50
              ? (getColor('warning') !== '' ? getColor('warning') : undefined)
              : (getColor('inactive') !== '' ? getColor('inactive') : undefined)
        }
        dimColor={displayCtx < 50}
      >
        {formatCtx(displayCtx)}
      </Text>
    </Box>
  );
}
