// idleHeartbeat.ts — SPEC-117: idle timer that offers a soft suggestion after user inactivity.
// Heuristic-based (no LLM), fires once per idle cycle, configurable via workspace config.
// Only active in a real TTY; disabled in CI and when configured off.

import { logger } from '../../observability/logger.ts';
import { colors } from './colors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LastContext = 'read' | 'error' | 'fresh' | 'default';

export interface IdleMonitorOpts {
  /** Idle delay in ms before suggestion fires. Default: 60_000. */
  delayMs?: number;
  /** Whether the monitor is enabled. Default: true. */
  enabled?: boolean;
  /** True when running in a real TTY (from process.stdout.isTTY). */
  isTTY?: boolean;
  /** True when CI env is detected (process.env.CI === '1'). */
  isCI?: boolean;
  /** Output stream for suggestion. Default: process.stdout. */
  output?: NodeJS.WritableStream;
  /** Provide current last context. Called at fire time. */
  getLastContext?: () => LastContext;
}

export interface IdleMonitor {
  /** Reset the idle timer (call on every user input). */
  reset(): void;
  /** Start the timer (call once REPL is ready). */
  start(): void;
  /** Stop and tear down the timer (call on REPL teardown). */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Suggestion text
// ---------------------------------------------------------------------------

export function suggestionFor(ctx: LastContext): string {
  switch (ctx) {
    case 'read':
      return 'Need help understanding this file?';
    case 'error':
      return 'Want me to debug that?';
    case 'fresh':
      return 'What can I help with today?';
    default:
      return 'Still here if you need anything.';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const DEFAULT_IDLE_DELAY_MS = 60_000;

/**
 * Create an idle monitor. Call `start()` when the REPL is ready,
 * `reset()` on every user keystroke, and `stop()` on teardown.
 */
export function createIdleMonitor(opts: IdleMonitorOpts = {}): IdleMonitor {
  const {
    delayMs = DEFAULT_IDLE_DELAY_MS,
    enabled = true,
    isTTY = typeof process.stdout.isTTY === 'boolean' ? process.stdout.isTTY : false,
    isCI = process.env['CI'] === '1',
    output = process.stdout,
    getLastContext = () => 'default' as LastContext,
  } = opts;

  // Determine if the monitor should actually fire.
  const active = enabled && isTTY && !isCI;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let firedThisCycle = false;

  function arm(): void {
    if (!active) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (firedThisCycle) {
        // Already fired this idle cycle — don't spam.
        return;
      }
      firedThisCycle = true;
      const ctx = getLastContext();
      const msg = suggestionFor(ctx);
      const line = colors.dim(`\n[NIMBUS] ${msg}\n`);
      output.write(line);
      logger.info({ event: 'idle_heartbeat', ctx }, 'idle heartbeat fired');
    }, delayMs);
  }

  function reset(): void {
    firedThisCycle = false;
    if (active) arm();
  }

  function start(): void {
    if (!active) return;
    arm();
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    firedThisCycle = false;
  }

  return { reset, start, stop };
}
