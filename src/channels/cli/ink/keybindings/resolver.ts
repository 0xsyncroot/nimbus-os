// resolver.ts — SPEC-849: Context-stack keybinding resolver.
// Deepest context in the stack wins (innermost modal overrides global).
// Chord prefix: leader key (ctrl+g or \) starts 1500ms timeout window.
// Single ctrl+<letter> keys are IMMEDIATE — never chord prefixes (readline compat).
// Unknown actions → logger.warn + skip. NEVER eval/dispatch as shell/tool.

import { logger } from '../../../../observability/logger.ts';
import type { KeybindingAction } from './defaultBindings.ts';
import { isSingleCtrlLetter, isChord } from './defaultBindings.ts';
import type { KeybindingContext, KeybindingManager } from './index.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

export const CHORD_TIMEOUT_MS = 1500;
const CHORD_LEADERS = new Set(['ctrl+g', '\\']);

// ── Chord state ────────────────────────────────────────────────────────────────

interface ChordState {
  leader: string;
  timerId: ReturnType<typeof setTimeout>;
}

// ── Resolver factory ───────────────────────────────────────────────────────────

/**
 * Creates a stateful resolver for the given bindings map.
 * Returned resolve() function maintains chord state between calls.
 */
export function createResolver(manager: KeybindingManager): {
  resolve: (contextStack: KeybindingContext[], key: string) => KeybindingAction | undefined;
  dispose: () => void;
} {
  let chordState: ChordState | null = null;

  function clearChord(): void {
    if (chordState) {
      clearTimeout(chordState.timerId);
      chordState = null;
    }
  }

  function resolve(
    contextStack: KeybindingContext[],
    key: string,
  ): KeybindingAction | undefined {
    // Esc always clears chord state
    if (key === 'escape') {
      clearChord();
    }

    // If we have a pending chord leader, try to complete the chord
    if (chordState) {
      const chordKey = `${chordState.leader} ${key}`;
      clearChord();
      return lookupKey(manager, contextStack, chordKey);
    }

    // Single ctrl+<letter> keys are IMMEDIATE — never chord prefixes
    if (isSingleCtrlLetter(key) && !CHORD_LEADERS.has(key)) {
      return lookupKey(manager, contextStack, key);
    }

    // Check if this key is a chord leader
    if (CHORD_LEADERS.has(key)) {
      // Start chord timeout window
      const timerId = setTimeout(() => {
        chordState = null;
      }, CHORD_TIMEOUT_MS);
      chordState = { leader: key, timerId };
      return undefined; // Waiting for second key
    }

    // Backslash leader: handle \ prefix chords (e.g., \h)
    if (key.startsWith('\\') && key.length > 1 && isChord(key)) {
      return lookupKey(manager, contextStack, key);
    }

    return lookupKey(manager, contextStack, key);
  }

  function dispose(): void {
    clearChord();
  }

  return { resolve, dispose };
}

// ── Context-stack lookup ───────────────────────────────────────────────────────

/**
 * Searches the context stack from deepest (last) to shallowest (first).
 * Deepest context wins. Unknown action strings → logger.warn + skip.
 */
function lookupKey(
  manager: KeybindingManager,
  contextStack: KeybindingContext[],
  key: string,
): KeybindingAction | undefined {
  // Iterate from deepest context to shallowest
  for (let i = contextStack.length - 1; i >= 0; i--) {
    const ctx = contextStack[i];
    if (!ctx) continue;
    const action = manager.getBindingForContext(ctx, key);
    if (action !== undefined) {
      // Validate: action must be a known KeybindingAction (type-guard via manager)
      if (typeof action !== 'string') {
        logger.warn({ ctx, key, action }, '[SPEC-849] resolver: non-string action — skipping');
        return undefined;
      }
      return action;
    }
  }
  return undefined;
}
