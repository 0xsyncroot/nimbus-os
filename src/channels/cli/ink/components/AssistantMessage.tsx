// AssistantMessage.tsx — SPEC-843: Assistant text block wrapper.
// Streaming deltas update buffer and render raw text; on isComplete=true the
// finished block commits to <Static> (prevents re-render on past content).
// MAX_STATIC_BLOCKS=500 LRU-evicts oldest blocks beyond the limit.
// Markdown rendered via Markdown.tsx only on completed blocks.

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Static } from 'ink';
import { Markdown } from './Markdown.tsx';
import { stripAnsiOsc } from './Markdown.tsx';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AssistantTextBlock {
  /** Unique block ID, e.g. message_id + content_block index. */
  id: string;
  /** Accumulated text delta (partial while streaming, full when complete). */
  text: string;
  /** True once message_stop has fired for this block. */
  isComplete: boolean;
}

// ── Static block store ────────────────────────────────────────────────────────
export const MAX_STATIC_BLOCKS = 500;

interface StaticBlock {
  id: string;
  text: string;
}

/**
 * Manages the LRU-evicted static blocks list.
 * Returns a new array capped at MAX_STATIC_BLOCKS (oldest evicted first).
 */
export function addStaticBlock(
  current: readonly StaticBlock[],
  block: StaticBlock,
): StaticBlock[] {
  const next = [...current, block];
  if (next.length > MAX_STATIC_BLOCKS) {
    return next.slice(next.length - MAX_STATIC_BLOCKS);
  }
  return next;
}

// ── Component ─────────────────────────────────────────────────────────────────
export interface AssistantMessageProps {
  /** Streaming deltas — updated externally as new chunks arrive. */
  blocks: AssistantTextBlock[];
  /** True once the full message has completed (drives Static commit). */
  isComplete: boolean;
}

export function AssistantMessage({
  blocks,
  isComplete,
}: AssistantMessageProps): React.ReactElement {
  const [staticBlocks, setStaticBlocks] = useState<StaticBlock[]>([]);
  const committedIds = useRef<Set<string>>(new Set());

  // Commit completed blocks to <Static> (once per block ID)
  useEffect(() => {
    if (!isComplete) return;
    const toCommit = blocks.filter(
      (b) => b.isComplete && !committedIds.current.has(b.id),
    );
    if (toCommit.length === 0) return;
    setStaticBlocks((prev) => {
      let next = [...prev];
      for (const block of toCommit) {
        committedIds.current.add(block.id);
        next = addStaticBlock(next, { id: block.id, text: block.text });
      }
      return next;
    });
  }, [blocks, isComplete]);

  // Active (in-progress) blocks — render raw stripped text
  const activeBlocks = blocks.filter(
    (b) => !committedIds.current.has(b.id),
  );

  return (
    <Box flexDirection="column">
      {/* Completed blocks — rendered once, never updated */}
      <Static items={staticBlocks}>
        {(item: StaticBlock) => (
          <Box key={item.id} flexDirection="column">
            <Markdown text={item.text} raw={false} />
          </Box>
        )}
      </Static>

      {/* In-progress blocks — raw stripped text only */}
      {activeBlocks.map((block) => (
        <Box key={block.id} flexDirection="column">
          <Text>{stripAnsiOsc(block.text)}</Text>
        </Box>
      ))}
    </Box>
  );
}
