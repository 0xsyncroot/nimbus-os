// thinkingCapture.test.ts — SPEC-116: unit tests for thinking trace capture.

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  captureThinking,
  getTraces,
  getLastTrace,
  clearTraces,
  supportsThinking,
  MAX_TRACES,
  type ThinkingTrace,
} from '../../src/context/thinkingCapture.ts';
import type { CanonicalBlock } from '../../src/ir/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThinkingBlock(text: string): CanonicalBlock {
  return { type: 'thinking', text };
}

function makeTextBlock(text: string): CanonicalBlock {
  return { type: 'text', text };
}

const SESSION = 'session-abc';
const TURN_1 = 'turn-001';
const TURN_2 = 'turn-002';
const MODEL = 'claude-sonnet-4-6';
const EFFORT = 'medium';

// ---------------------------------------------------------------------------
// supportsThinking
// ---------------------------------------------------------------------------

describe('SPEC-116: supportsThinking', () => {
  test('returns true for claude-sonnet-4-5', () => {
    expect(supportsThinking('claude-sonnet-4-5')).toBe(true);
  });

  test('returns true for claude-sonnet-4-6', () => {
    expect(supportsThinking('claude-sonnet-4-6')).toBe(true);
  });

  test('returns true for claude-opus-4-6', () => {
    expect(supportsThinking('claude-opus-4-6')).toBe(true);
  });

  test('returns true for model with -thinking suffix', () => {
    expect(supportsThinking('claude-haiku-4-thinking')).toBe(true);
  });

  test('returns false for gpt-4o', () => {
    expect(supportsThinking('gpt-4o')).toBe(false);
  });

  test('returns false for llama-3', () => {
    expect(supportsThinking('llama-3')).toBe(false);
  });

  test('returns false for empty model string', () => {
    expect(supportsThinking('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureThinking + getTraces
// ---------------------------------------------------------------------------

describe('SPEC-116: captureThinking', () => {
  const sid = `${SESSION}-capture`;

  beforeEach(() => {
    clearTraces(sid);
  });

  test('stores a thinking block as a trace', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeThinkingBlock('I think deeply.')]);
    const traces = getTraces(sid);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.text).toBe('I think deeply.');
    expect(traces[0]?.turnId).toBe(TURN_1);
    expect(traces[0]?.model).toBe(MODEL);
    expect(traces[0]?.effort).toBe(EFFORT);
  });

  test('multiple thinking blocks in one call produce multiple traces', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [
      makeThinkingBlock('block one'),
      makeThinkingBlock('block two'),
    ]);
    expect(getTraces(sid)).toHaveLength(2);
  });

  test('non-thinking blocks are ignored (empty → no-op)', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeTextBlock('hello'), makeTextBlock('world')]);
    expect(getTraces(sid)).toHaveLength(0);
  });

  test('empty blocks array is a no-op', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, []);
    expect(getTraces(sid)).toHaveLength(0);
  });

  test('mixed blocks: only thinking captured', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [
      makeTextBlock('assistant text'),
      makeThinkingBlock('inner reasoning'),
    ]);
    const traces = getTraces(sid);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.text).toBe('inner reasoning');
  });

  test('trace timestamp is a positive number', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeThinkingBlock('hi')]);
    const [trace] = getTraces(sid);
    expect(trace?.timestamp).toBeGreaterThan(0);
  });

  test('trace tokens is a positive number estimated from text length', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeThinkingBlock('a'.repeat(400))]);
    const [trace] = getTraces(sid);
    expect(trace?.tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FIFO cap at MAX_TRACES
// ---------------------------------------------------------------------------

describe('SPEC-116: FIFO cap at MAX_TRACES', () => {
  const sid = `${SESSION}-fifo`;

  beforeEach(() => {
    clearTraces(sid);
  });

  test(`does not exceed ${MAX_TRACES} traces`, () => {
    for (let i = 0; i < MAX_TRACES + 10; i++) {
      captureThinking(sid, `turn-${i}`, MODEL, EFFORT, [makeThinkingBlock(`trace ${i}`)]);
    }
    const traces = getTraces(sid);
    expect(traces).toHaveLength(MAX_TRACES);
  });

  test('oldest trace is evicted (FIFO)', () => {
    for (let i = 0; i < MAX_TRACES + 5; i++) {
      captureThinking(sid, `turn-${i}`, MODEL, EFFORT, [makeThinkingBlock(`trace ${i}`)]);
    }
    const traces = getTraces(sid);
    // First entry should be turn-5 (first 5 were evicted)
    expect(traces[0]?.text).toBe('trace 5');
  });
});

// ---------------------------------------------------------------------------
// getTraces filtering
// ---------------------------------------------------------------------------

describe('SPEC-116: getTraces filtering', () => {
  const sid = `${SESSION}-filter`;

  beforeEach(() => {
    clearTraces(sid);
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeThinkingBlock('turn1 trace')]);
    captureThinking(sid, TURN_2, MODEL, EFFORT, [makeThinkingBlock('turn2 trace')]);
  });

  test('returns all traces when no filter', () => {
    expect(getTraces(sid)).toHaveLength(2);
  });

  test('filters by turnId', () => {
    const t1 = getTraces(sid, { turnId: TURN_1 });
    expect(t1).toHaveLength(1);
    expect(t1[0]?.text).toBe('turn1 trace');
  });

  test('returns empty array for unknown turnId', () => {
    expect(getTraces(sid, { turnId: 'unknown-turn' })).toHaveLength(0);
  });

  test('getTraces returns a copy (not the internal array)', () => {
    const result = getTraces(sid);
    result.splice(0, result.length); // clear the copy
    expect(getTraces(sid)).toHaveLength(2); // original unchanged
  });
});

// ---------------------------------------------------------------------------
// getLastTrace
// ---------------------------------------------------------------------------

describe('SPEC-116: getLastTrace', () => {
  const sid = `${SESSION}-last`;

  beforeEach(() => {
    clearTraces(sid);
  });

  test('returns null for session with no traces', () => {
    expect(getLastTrace(sid)).toBeNull();
  });

  test('returns the most recently captured trace', () => {
    captureThinking(sid, TURN_1, MODEL, EFFORT, [makeThinkingBlock('first')]);
    captureThinking(sid, TURN_2, MODEL, EFFORT, [makeThinkingBlock('second')]);
    const last = getLastTrace(sid);
    expect(last?.text).toBe('second');
  });
});
