// cancellation.ts — SPEC-103: 3-tier abort tree (turn > tool/provider).

import { onInterrupt } from '../platform/signals.ts';

export interface TurnAbort {
  turn: AbortController;
  tool: AbortController;
  provider: AbortController;
  dispose(): void;
}

export function createTurnAbort(parent?: AbortSignal): TurnAbort {
  const turn = new AbortController();
  const tool = new AbortController();
  const provider = new AbortController();

  const propagate = (from: AbortSignal, to: AbortController): (() => void) => {
    if (from.aborted) {
      to.abort(from.reason);
      return () => undefined;
    }
    const h = (): void => to.abort(from.reason);
    from.addEventListener('abort', h, { once: true });
    return () => from.removeEventListener('abort', h);
  };

  const cleanup: Array<() => void> = [];
  cleanup.push(propagate(turn.signal, tool));
  cleanup.push(propagate(turn.signal, provider));
  if (parent) cleanup.push(propagate(parent, turn));

  return {
    turn,
    tool,
    provider,
    dispose(): void {
      for (const c of cleanup) {
        try { c(); } catch { /* swallow */ }
      }
    },
  };
}

export const CANCEL_ESCALATION_WINDOW_MS = 1500;

export interface EscalationState {
  pressCount: number;
  lastPressAt: number;
}

export function createSigintEscalator(
  turnAbort: () => TurnAbort | null,
  onExit: () => void = () => process.exit(0),
  now: () => number = () => Date.now(),
): { dispose: () => void; state: () => EscalationState } {
  const state: EscalationState = { pressCount: 0, lastPressAt: 0 };
  const dispose = onInterrupt(() => {
    const ts = now();
    if (ts - state.lastPressAt > CANCEL_ESCALATION_WINDOW_MS) state.pressCount = 0;
    state.pressCount += 1;
    state.lastPressAt = ts;
    const abt = turnAbort();
    if (state.pressCount === 1) {
      abt?.tool.abort(new Error('sigint_tool'));
    } else if (state.pressCount === 2) {
      abt?.turn.abort(new Error('sigint_turn'));
    } else {
      onExit();
    }
  });
  return { dispose, state: () => state };
}
