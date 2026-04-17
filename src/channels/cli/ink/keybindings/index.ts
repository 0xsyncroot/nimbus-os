// index.ts — SPEC-849: KeybindingManager factory.
// Context stack: deepest wins. Chord timeout 1500ms.
// register() rejects reserved keys. loadUserOverrides() merges on top of defaults.
// dispatch() resolves via context stack; unknown actions → logger.warn + skip.

import { logger } from '../../../../observability/logger.ts';
import { DEFAULT_BINDINGS } from './defaultBindings.ts';
import type { KeybindingAction, BindingsMap } from './defaultBindings.ts';
import { assertNotReserved } from './reservedShortcuts.ts';
import { createResolver } from './resolver.ts';
import { loadUserOverrides } from './userOverrides.ts';

export type { KeybindingAction } from './defaultBindings.ts';

// ── Context type ───────────────────────────────────────────────────────────────

export type KeybindingContext =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Select'
  | 'Confirmation'
  | 'Scroll'
  | 'HistorySearch'
  | 'Transcript'
  | 'Help';

// ── Manager interface ──────────────────────────────────────────────────────────

export interface KeybindingManager {
  /** Register a key→action binding for a given context. Throws on reserved keys. */
  register(context: KeybindingContext, key: string, action: KeybindingAction): void;
  /** Resolve a key against a context stack. Deepest context wins. */
  resolve(contextStack: KeybindingContext[], key: string): KeybindingAction | undefined;
  /** Load user overrides from ~/.nimbus/keybindings.json (or custom path for tests). */
  loadUserOverrides(path?: string): Promise<void>;
  /** Push a context onto the stack. */
  pushContext(context: KeybindingContext): void;
  /** Pop the topmost context from the stack. */
  popContext(): KeybindingContext | undefined;
  /** Get the current active context stack (shallow copy). */
  getActive(): KeybindingContext[];
  /** Internal: get binding for a specific context + key (used by resolver). */
  getBindingForContext(context: KeybindingContext, key: string): KeybindingAction | undefined;
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Creates a new KeybindingManager instance populated with default bindings.
 * Call loadUserOverrides() after construction to apply ~/.nimbus/keybindings.json.
 */
export function createKeybindingManager(): KeybindingManager {
  // Mutable bindings map (starts as a deep copy of defaults)
  const bindings = new Map<KeybindingContext, Map<string, KeybindingAction>>();

  // Populate from defaults
  for (const [ctx, ctxBindings] of DEFAULT_BINDINGS as BindingsMap) {
    bindings.set(ctx, new Map(ctxBindings));
  }

  const contextStack: KeybindingContext[] = ['Global'];

  const manager: KeybindingManager = {
    register(context, key, action): void {
      assertNotReserved(key);
      const ctxMap = bindings.get(context) ?? new Map<string, KeybindingAction>();
      ctxMap.set(key, action);
      bindings.set(context, ctxMap);
    },

    resolve(contextStack, key): KeybindingAction | undefined {
      return resolver.resolve(contextStack, key);
    },

    async loadUserOverrides(customPath?: string): Promise<void> {
      const overrides = await loadUserOverrides(customPath);
      if (!overrides) return;

      for (const [ctx, ctxOverrides] of Object.entries(overrides)) {
        const context = ctx as KeybindingContext;
        const ctxMap = bindings.get(context) ?? new Map<string, KeybindingAction>();
        for (const [key, action] of Object.entries(ctxOverrides)) {
          ctxMap.set(key, action as KeybindingAction);
        }
        bindings.set(context, ctxMap);
      }
      logger.info('[SPEC-849] keybindings: user overrides applied');
    },

    pushContext(context): void {
      contextStack.push(context);
    },

    popContext(): KeybindingContext | undefined {
      if (contextStack.length <= 1) return undefined;
      return contextStack.pop();
    },

    getActive(): KeybindingContext[] {
      return [...contextStack];
    },

    getBindingForContext(context, key): KeybindingAction | undefined {
      return bindings.get(context)?.get(key);
    },
  };

  const resolver = createResolver(manager);

  return manager;
}
