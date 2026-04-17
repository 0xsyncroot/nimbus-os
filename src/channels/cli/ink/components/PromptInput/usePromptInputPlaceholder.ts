// usePromptInputPlaceholder.ts — SPEC-841: Placeholder rotation.
// Priority: teammate > queue (max 3×) > example.
// Rotates every 8 s between available non-null sources.

import { useState, useEffect, useCallback } from 'react';

const ROTATION_INTERVAL_MS = 8_000;
const QUEUE_HINT_MAX_SHOWN = 3;

const EXAMPLE_PLACEHOLDERS: readonly string[] = [
  'Ask anything — /help for commands',
  'Type @ to reference a file, ! for shell, # for notes',
  'Shift+Enter for multi-line input',
];

export interface UsePlaceholderOpts {
  /** When non-null, teammate hint is shown with highest priority */
  teammateName?: string | null;
  /** Whether there are queued commands to navigate */
  hasQueuedCommands?: boolean;
  /** Whether input is empty (placeholder only shown when empty) */
  isEmpty: boolean;
  /** Submit count — used to cycle examples only on first session */
  submitCount?: number;
}

export function usePromptInputPlaceholder({
  teammateName,
  hasQueuedCommands,
  isEmpty,
  submitCount = 0,
}: UsePlaceholderOpts): string {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [queueHintShown, setQueueHintShown] = useState(0);

  const computePlaceholder = useCallback((): string => {
    if (!isEmpty) return '';

    // Priority 1: teammate hint
    if (teammateName) {
      const name = teammateName.length > 20
        ? teammateName.slice(0, 17) + '...'
        : teammateName;
      return `Message @${name}…`;
    }

    // Priority 2: queue hint (max 3×)
    if (hasQueuedCommands && queueHintShown < QUEUE_HINT_MAX_SHOWN) {
      return 'Press ↑ to edit queued messages';
    }

    // Priority 3: example commands (first session only, or always after threshold)
    return EXAMPLE_PLACEHOLDERS[exampleIndex % EXAMPLE_PLACEHOLDERS.length] ?? '';
  }, [isEmpty, teammateName, hasQueuedCommands, queueHintShown, exampleIndex, submitCount]);

  const [placeholder, setPlaceholder] = useState<string>(() => computePlaceholder());

  // Recompute immediately when deps change
  useEffect(() => {
    setPlaceholder(computePlaceholder());
  }, [computePlaceholder]);

  // Rotate every 8 s
  useEffect(() => {
    if (!isEmpty) return;
    const id = setInterval(() => {
      // Advance queue hint counter when it's being shown
      if (hasQueuedCommands && queueHintShown < QUEUE_HINT_MAX_SHOWN) {
        setQueueHintShown(n => n + 1);
      } else {
        setExampleIndex(i => (i + 1) % EXAMPLE_PLACEHOLDERS.length);
      }
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isEmpty, hasQueuedCommands, queueHintShown]);

  return placeholder;
}
