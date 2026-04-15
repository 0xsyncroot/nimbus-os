import { describe, expect, test } from 'bun:test';
import { createTurnAbort } from '../../src/core/cancellation.ts';

describe('SPEC-103: 3-tier abort', () => {
  test('parent abort propagates to tool + provider', () => {
    const t = createTurnAbort();
    t.turn.abort();
    expect(t.tool.signal.aborted).toBe(true);
    expect(t.provider.signal.aborted).toBe(true);
  });

  test('aborting child does not abort sibling', () => {
    const t = createTurnAbort();
    t.tool.abort();
    expect(t.turn.signal.aborted).toBe(false);
    expect(t.provider.signal.aborted).toBe(false);
  });

  test('parent signal propagates to turn', () => {
    const parent = new AbortController();
    const t = createTurnAbort(parent.signal);
    parent.abort();
    expect(t.turn.signal.aborted).toBe(true);
    expect(t.tool.signal.aborted).toBe(true);
    expect(t.provider.signal.aborted).toBe(true);
  });

  test('dispose runs cleanup once', () => {
    const t = createTurnAbort();
    t.dispose();
    t.dispose();
  });
});
