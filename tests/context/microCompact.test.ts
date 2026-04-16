// microCompact.test.ts — SPEC-120: micro compaction tests.
// Covers tool result clearing, recency preservation, sentinel text.

import { describe, expect, test } from 'bun:test';
import {
  microCompact,
  COMPACTABLE_TOOLS,
  MICRO_COMPACT_RECENCY,
  clearSentinel,
} from '../../src/context/microCompact.ts';
import type { CanonicalMessage } from '../../src/ir/types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeToolUseMsg(toolUseId: string, name: string): CanonicalMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolUseId, name, input: {} }],
  };
}

function makeToolResultMsg(toolUseId: string, content: string): CanonicalMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, content }],
  };
}

function getToolResultContent(msg: CanonicalMessage, blockIndex = 0): string | unknown {
  if (typeof msg.content === 'string') return msg.content;
  const block = msg.content[blockIndex];
  if (!block || block.type !== 'tool_result') return '';
  return typeof block.content === 'string' ? block.content : block.content;
}

// ---------------------------------------------------------------------------
// clearSentinel
// ---------------------------------------------------------------------------

describe('SPEC-120: clearSentinel', () => {
  test('includes saved token count in sentinel text', () => {
    const sentinel = clearSentinel(500);
    expect(sentinel).toContain('500');
    expect(sentinel).toContain('tokens saved');
  });

  test('format: [result cleared — N tokens saved]', () => {
    expect(clearSentinel(100)).toBe('[result cleared — 100 tokens saved]');
  });
});

// ---------------------------------------------------------------------------
// COMPACTABLE_TOOLS set
// ---------------------------------------------------------------------------

describe('SPEC-120: COMPACTABLE_TOOLS', () => {
  test('includes all 8 expected tools', () => {
    const expected = ['Read', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Edit', 'Write'];
    for (const tool of expected) {
      expect(COMPACTABLE_TOOLS.has(tool)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// microCompact — no-op cases
// ---------------------------------------------------------------------------

describe('SPEC-120: microCompact no-op', () => {
  test('empty messages returns unchanged', () => {
    const result = microCompact([], 'anthropic');
    expect(result.messages).toHaveLength(0);
    expect(result.stats.clearedCount).toBe(0);
  });

  test('messages with no tool_result blocks unchanged', () => {
    const msgs: CanonicalMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const result = microCompact(msgs, 'anthropic');
    expect(result.messages).toHaveLength(2);
    expect(result.stats.clearedCount).toBe(0);
  });

  test('non-compactable tool results are NOT cleared', () => {
    // A tool not in COMPACTABLE_TOOLS
    const msgs: CanonicalMessage[] = [
      makeToolUseMsg('id-1', 'CustomTool'),
      makeToolResultMsg('id-1', 'custom result content'),
    ];
    const result = microCompact(msgs, 'anthropic');
    expect(result.stats.clearedCount).toBe(0);
    expect(getToolResultContent(result.messages[1]!)).toBe('custom result content');
  });
});

// ---------------------------------------------------------------------------
// microCompact — clearing behavior
// ---------------------------------------------------------------------------

describe('SPEC-120: microCompact clears stale results', () => {
  test('clears tool results beyond recency buffer', () => {
    // Create 5 Read tool results — last 3 should be kept, first 2 cleared
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Read'));
      msgs.push(makeToolResultMsg(`id-${i}`, `content of read ${i} `.repeat(100)));
    }

    const result = microCompact(msgs, 'anthropic');
    expect(result.stats.clearedCount).toBe(5 - MICRO_COMPACT_RECENCY);
  });

  test('cleared results contain sentinel text', () => {
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Bash'));
      msgs.push(makeToolResultMsg(`id-${i}`, 'output '.repeat(50)));
    }

    const result = microCompact(msgs, 'anthropic');
    // First tool result (index 1) should be cleared
    const firstResult = result.messages[1]!;
    const content = getToolResultContent(firstResult);
    expect(typeof content).toBe('string');
    expect(content as string).toContain('tokens saved');
  });

  test('savedTokens is positive when results are cleared', () => {
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Grep'));
      msgs.push(makeToolResultMsg(`id-${i}`, 'grep output line '.repeat(200)));
    }

    const result = microCompact(msgs, 'anthropic');
    expect(result.stats.savedTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Recency preservation
// ---------------------------------------------------------------------------

describe('SPEC-120: microCompact recency preservation', () => {
  test('last 3 results are never cleared', () => {
    const msgs: CanonicalMessage[] = [];
    const contents = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (let i = 0; i < 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Read'));
      msgs.push(makeToolResultMsg(`id-${i}`, contents[i]!.repeat(50)));
    }

    const result = microCompact(msgs, 'anthropic');

    // Last 3 results (indices 6,7,8,9 in msgs) should be preserved
    const last3 = [
      result.messages[result.messages.length - 5]!,
      result.messages[result.messages.length - 3]!,
      result.messages[result.messages.length - 1]!,
    ];

    for (const msg of last3) {
      const content = getToolResultContent(msg);
      expect(content as string).not.toContain('tokens saved');
    }
  });

  test('exactly MICRO_COMPACT_RECENCY=3 results kept when many results present', () => {
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'WebSearch'));
      msgs.push(makeToolResultMsg(`id-${i}`, 'search result '.repeat(100)));
    }

    const result = microCompact(msgs, 'anthropic');
    // 10 results: first 7 cleared, last 3 kept
    expect(result.stats.clearedCount).toBe(10 - MICRO_COMPACT_RECENCY);
  });
});

// ---------------------------------------------------------------------------
// Provider-aware behavior
// ---------------------------------------------------------------------------

describe('SPEC-120: microCompact provider awareness', () => {
  test('anthropic and openai-compat both produce cleared results (content mutation)', () => {
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Read'));
      msgs.push(makeToolResultMsg(`id-${i}`, 'file content '.repeat(100)));
    }

    const resultAnthropric = microCompact([...msgs], 'anthropic');
    const resultOpenai = microCompact([...msgs], 'openai-compat');

    // Both should clear the same number of results
    expect(resultAnthropric.stats.clearedCount).toBe(resultOpenai.stats.clearedCount);
  });
});

// ---------------------------------------------------------------------------
// Non-mutation
// ---------------------------------------------------------------------------

describe('SPEC-120: microCompact immutability', () => {
  test('does not mutate original messages array', () => {
    const msgs: CanonicalMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(makeToolUseMsg(`id-${i}`, 'Bash'));
      msgs.push(makeToolResultMsg(`id-${i}`, 'output '.repeat(100)));
    }

    const originalContent = getToolResultContent(msgs[1]!);
    microCompact(msgs, 'anthropic');
    expect(getToolResultContent(msgs[1]!)).toBe(originalContent);
  });
});
