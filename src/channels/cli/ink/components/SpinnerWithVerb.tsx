// SpinnerWithVerb.tsx — SPEC-843: Spinner with verb rotation, stall color, reduced-motion.
// Ping-pong frame animation, stall linear RGB lerp toward error rgb(171,43,63),
// reduced-motion solid ● pulse at REDUCED_MOTION_CYCLE_MS=2000.
// Frame updates isolated to this subtree via useReducer + React.memo.

import React, { useEffect, useReducer, useRef, useMemo } from 'react';
import { Text, Box } from 'ink';
import { SPINNER_FRAMES_PINGPONG, BULLET_GLYPH } from '../constants/figures.ts';
import { SPINNER_VERBS } from '../constants/spinnerVerbs.ts';
import { useAppContext } from '../app.tsx';
import { useTheme } from '../theme.ts';

// ── Timing constants ───────────────────────────────────────────────────────────
export const FRAME_INTERVAL_MS = 80;
export const STALL_THRESHOLD_MS = 3000;
export const REDUCED_MOTION_CYCLE_MS = 2000;

// ── Stall color constants ─────────────────────────────────────────────────────
// Claude theme rgb(215,119,87) → stall error rgb(171,43,63)
const STALL_FROM = { r: 215, g: 119, b: 87 } as const;
const STALL_TO = { r: 171, g: 43, b: 63 } as const;

// ── Linear RGB lerp (exported for tests) ─────────────────────────────────────
export function lerpColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(STALL_FROM.r + (STALL_TO.r - STALL_FROM.r) * clamped);
  const g = Math.round(STALL_FROM.g + (STALL_TO.g - STALL_FROM.g) * clamped);
  const b = Math.round(STALL_FROM.b + (STALL_TO.b - STALL_FROM.b) * clamped);
  return `rgb(${r},${g},${b})`;
}

// ── Verb selection helper (exported for tests) ────────────────────────────────
export function pickVerb(overrideVerb?: string): string {
  if (overrideVerb) return overrideVerb;
  const idx = Math.floor(Math.random() * SPINNER_VERBS.length);
  return SPINNER_VERBS[idx] ?? SPINNER_VERBS[0] ?? 'Thinking';
}

// ── useReducer tick (isolates subtree re-renders) ─────────────────────────────
type SpinnerState = { frame: number; tick: number };
type SpinnerAction = { type: 'TICK' };

function spinnerReducer(state: SpinnerState, action: SpinnerAction): SpinnerState {
  if (action.type === 'TICK') {
    return {
      frame: (state.frame + 1) % SPINNER_FRAMES_PINGPONG.length,
      tick: state.tick + 1,
    };
  }
  return state;
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface SpinnerWithVerbProps {
  /** Overrides random verb from SPINNER_VERBS. */
  verb?: string;
  /** Triggers stall color interpolation toward ERROR_RED. */
  stalled?: boolean;
  /** Seconds since last delta — drives stall interpolation (0 = fresh, 3+ = fully stalled). */
  stallSecs?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const SpinnerWithVerb = React.memo(function SpinnerWithVerb({
  verb,
  stalled = false,
  stallSecs = 0,
}: SpinnerWithVerbProps): React.ReactElement {
  const { reducedMotion, noColor } = useAppContext();
  const getColor = useTheme();

  // Stable verb picked once on mount
  const verbRef = useRef<string>(pickVerb(verb));
  if (verb !== undefined && verb !== verbRef.current) {
    verbRef.current = verb;
  }

  const [state, dispatch] = useReducer(spinnerReducer, { frame: 0, tick: 0 });

  // Reduced-motion pulse tick (slower interval, toggles dim)
  const [dimPulse, setDimPulse] = React.useState(false);

  useEffect(() => {
    if (reducedMotion) {
      const id = setInterval(() => setDimPulse((d) => !d), REDUCED_MOTION_CYCLE_MS / 2);
      return () => clearInterval(id);
    }
    const id = setInterval(() => dispatch({ type: 'TICK' }), FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  // Stall color interpolation
  const spinnerColor = useMemo(() => {
    if (noColor) return undefined;
    if (stalled && stallSecs > 0) {
      const t = Math.min(stallSecs / STALL_THRESHOLD_MS * 1000, 1);
      return lerpColor(t);
    }
    return getColor('claude');
  }, [stalled, stallSecs, noColor, getColor]);

  if (reducedMotion) {
    return (
      <Box>
        <Text color={noColor ? undefined : getColor('inactive')} dimColor={dimPulse}>
          {BULLET_GLYPH}
        </Text>
        <Text> </Text>
        <Text color={noColor ? undefined : getColor('inactive')}>{verbRef.current}…</Text>
      </Box>
    );
  }

  const frame = SPINNER_FRAMES_PINGPONG[state.frame] ?? SPINNER_FRAMES_PINGPONG[0] ?? '·';

  return (
    <Box>
      <Text color={spinnerColor ?? undefined}>{frame}</Text>
      <Text> </Text>
      <Text color={noColor ? undefined : getColor('text')}>{verbRef.current}…</Text>
    </Box>
  );
});

SpinnerWithVerb.displayName = 'NimbusSpinnerWithVerb';
