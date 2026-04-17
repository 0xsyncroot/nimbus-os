// syncOutput.ts — SPEC-849: DECSET 2026 synchronized output wrapper.
// Prevents tmux/multiplexer flicker by bracketing Ink reconcile commits.
// Only emits when $TERM matches screen*/tmux* — no-op on plain terminals.
// Crash-safe: process.on('exit') + SIGINT emit reset to clear zombie state.

import { useInsertionEffect } from 'react';
import { logger } from '../../../observability/logger.ts';

// ── DECSET 2026 sequences ──────────────────────────────────────────────────────

const SYNC_START = '\x1b[?2026h';  // DECSET 2026 — begin synchronized output
const SYNC_END = '\x1b[?2026l';    // DECRST 2026 — end synchronized output (also reset)

// ── tmux/screen detection ──────────────────────────────────────────────────────

function isTmuxTerm(): boolean {
  const term = process.env['TERM'] ?? '';
  const termProgram = process.env['TERM_PROGRAM'] ?? '';
  return (
    term.startsWith('screen') ||
    term.startsWith('tmux') ||
    termProgram === 'tmux'
  );
}

// ── Low-level write helpers ────────────────────────────────────────────────────

function writeSync(seq: string): void {
  try {
    process.stdout.write(seq);
  } catch {
    // stdout may be closed during teardown — swallow silently
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Emit DECSET 2026 "begin synchronized output".
 * No-op when not running inside tmux/screen.
 */
export function beginSyncOutput(): void {
  if (!isTmuxTerm()) return;
  writeSync(SYNC_START);
}

/**
 * Emit DECRST 2026 "end synchronized output".
 * No-op when not running inside tmux/screen.
 */
export function endSyncOutput(): void {
  if (!isTmuxTerm()) return;
  writeSync(SYNC_END);
}

/**
 * React hook — wraps each Ink reconcile commit in DECSET 2026 brackets.
 * Call once at the root of the component tree (inside <App>).
 * Installs process.on('exit') + SIGINT to emit reset on crash.
 */
export function useSyncOutput(): void {
  useInsertionEffect(() => {
    if (!isTmuxTerm()) return;

    const resetHandler = (): void => {
      writeSync(SYNC_END);
    };

    process.on('exit', resetHandler);
    process.on('SIGINT', resetHandler);

    logger.info('[SPEC-849] DECSET 2026 sync-output enabled (tmux/screen detected)');

    beginSyncOutput();

    return (): void => {
      endSyncOutput();
      process.removeListener('exit', resetHandler);
      process.removeListener('SIGINT', resetHandler);
    };
  }, []);
}
