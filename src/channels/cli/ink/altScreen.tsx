// altScreen.tsx — SPEC-849: <AltScreen> component + useAltScreen() helper.
// Enters DEC 1049 alternate screen on mount, restores on unmount.
// Try/finally in useInsertionEffect ensures cleanup fires even if subtree throws.
// SIGINT + process.on('exit') handlers guarantee restore on crash/interrupt.
// Guard: does NOT emit CSI 3J (ink#935 scrollback wipe race).

import React, { useInsertionEffect, type PropsWithChildren } from 'react';
import { Box, useStdout } from 'ink';
import { logger } from '../../../observability/logger.ts';

// ── Terminal escape sequences ──────────────────────────────────────────────────

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[2J\x1b[H';
const CURSOR_SHOW = '\x1b[?25h';
// NOTE: CSI 3J (\x1b[3J) intentionally omitted — causes ink#935 scrollback wipe.

// ── Low-level write helper ─────────────────────────────────────────────────────

function writeToStdout(seq: string): void {
  try {
    process.stdout.write(seq);
  } catch {
    // Stdout may be closed during process teardown — swallow silently.
  }
}

// ── Cleanup factory — shared between component, SIGINT, and exit handlers ──────

function makeCleanup(): () => void {
  let fired = false;
  return function cleanup(): void {
    if (fired) return;
    fired = true;
    writeToStdout(EXIT_ALT_SCREEN + CURSOR_SHOW);
  };
}

// ── <AltScreen> component ──────────────────────────────────────────────────────

export type AltScreenProps = PropsWithChildren<{
  /** Optional: number of rows to constrain height to (defaults to stdout.rows). */
  rows?: number;
}>;

/**
 * Renders children inside the terminal alternate screen buffer.
 * - Enters DEC 1049 + clears screen on mount (useInsertionEffect, race-free).
 * - Exits DEC 1049 + restores cursor on unmount, SIGINT, and process exit.
 * - try/finally in the insertion effect ensures cleanup fires even if children throw.
 * - Does NOT emit CSI 3J to avoid ink#935 scrollback wipe.
 */
export function AltScreen({ children, rows }: AltScreenProps): React.ReactElement {
  const { stdout } = useStdout();
  const height = rows ?? stdout?.rows ?? 24;

  useInsertionEffect(() => {
    const cleanup = makeCleanup();

    // Install safety handlers before entering alt screen so crash/interrupt
    // can restore the terminal even if React teardown doesn't run.
    const sigintHandler = (): void => {
      cleanup();
      process.exit(130); // conventional SIGINT exit code
    };
    const exitHandler = (): void => {
      cleanup();
    };

    process.on('SIGINT', sigintHandler);
    process.on('exit', exitHandler);

    try {
      writeToStdout(ENTER_ALT_SCREEN + CURSOR_HOME);
    } catch (err) {
      // If entry itself fails, remove listeners and rethrow — no alt screen entered.
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('exit', exitHandler);
      logger.warn({ err }, '[SPEC-849] altScreen entry write failed');
      throw err;
    }

    return (): void => {
      try {
        cleanup();
      } finally {
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('exit', exitHandler);
      }
    };
  }, []);

  return (
    <Box flexDirection="column" height={height} width="100%" flexShrink={0}>
      {children}
    </Box>
  );
}

// ── useAltScreen() helper ──────────────────────────────────────────────────────

/**
 * Imperative helper for non-React code that needs to manually enter/exit
 * the alternate screen. Returns { enter, exit } functions.
 * Caller is responsible for calling exit() (preferably in a try/finally).
 */
export function useAltScreen(): { enter: () => void; exit: () => void } {
  const cleanup = makeCleanup();
  return {
    enter(): void {
      writeToStdout(ENTER_ALT_SCREEN + CURSOR_HOME);
    },
    exit: cleanup,
  };
}
