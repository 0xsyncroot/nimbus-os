// useAssistantStream — v0.4.0.2 P0 fix wire-up. Subscribes to bus events published
// by channels/cli/repl.ts handleSubmit; accumulates AssistantBlock[] for rendering
// by <AssistantMessage>. Without this hook the Ink REPL dark-launched SPEC-843.

import { useEffect, useState } from 'react';
import { getGlobalBus } from '../../../../core/events.ts';
import { TOPICS } from '../../../../core/eventTypes.ts';
import type {
  UiAssistantDeltaEvent,
  UiAssistantCompleteEvent,
  UiTurnStartEvent,
  UiTurnCompleteEvent,
} from '../../../../core/eventTypes.ts';

export interface AssistantBlock {
  id: string;
  turnId: string;
  text: string;
  complete: boolean;
}

interface AssistantStreamState {
  blocks: AssistantBlock[];
  isStreaming: boolean;
}

export function useAssistantStream(): AssistantStreamState {
  const [blocks, setBlocks] = useState<AssistantBlock[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    const bus = getGlobalBus();
    const offStart = bus.subscribe(TOPICS.ui.turnStart, (ev: UiTurnStartEvent) => {
      setIsStreaming(true);
      // keep prior completed blocks visible in transcript; only clear never-completed blocks.
      setBlocks((prev) => prev.filter((b) => b.complete));
      void ev;
    });
    const offDelta = bus.subscribe(TOPICS.ui.assistantDelta, (ev: UiAssistantDeltaEvent) => {
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === ev.blockId);
        if (idx >= 0) {
          const next = prev.slice();
          const cur = next[idx]!;
          next[idx] = { ...cur, text: cur.text + ev.text };
          return next;
        }
        return [...prev, { id: ev.blockId, turnId: ev.turnId, text: ev.text, complete: false }];
      });
    });
    const offComplete = bus.subscribe(TOPICS.ui.assistantComplete, (ev: UiAssistantCompleteEvent) => {
      setBlocks((prev) => {
        const idx = prev.findIndex((b) => b.id === ev.blockId);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = { ...next[idx]!, text: ev.text, complete: true };
          return next;
        }
        return [...prev, { id: ev.blockId, turnId: ev.turnId, text: ev.text, complete: true }];
      });
    });
    const offTurn = bus.subscribe(TOPICS.ui.turnComplete, (ev: UiTurnCompleteEvent) => {
      setIsStreaming(false);
      void ev;
    });
    return () => {
      offStart();
      offDelta();
      offComplete();
      offTurn();
    };
  }, []);

  return { blocks, isStreaming };
}
