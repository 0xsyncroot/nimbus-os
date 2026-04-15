// tests/tools/cancellation.test.ts — SPEC-301 T5.

import { describe, expect, test } from 'bun:test';
import { createCancellationScope } from '../../src/tools/cancellation.ts';

describe('SPEC-301: cancellation scope', () => {
  test('parent abort propagates to scope', async () => {
    const parent = new AbortController();
    const scope = createCancellationScope(parent.signal);
    expect(scope.signal.aborted).toBe(false);
    parent.abort(new Error('test'));
    expect(scope.signal.aborted).toBe(true);
  });

  test('onAbort fires cleanup exactly once', async () => {
    const parent = new AbortController();
    const scope = createCancellationScope(parent.signal);
    let count = 0;
    scope.onAbort(() => { count++; });
    scope.onAbort(() => { count++; });
    parent.abort();
    parent.abort();
    expect(count).toBe(2);
  });

  test('onAbort on already-aborted fires immediately', () => {
    const parent = new AbortController();
    parent.abort();
    const scope = createCancellationScope(parent.signal);
    let called = false;
    scope.onAbort(() => { called = true; });
    expect(called).toBe(true);
  });

  test('dispose prevents further cleanups', () => {
    const parent = new AbortController();
    const scope = createCancellationScope(parent.signal);
    let fired = false;
    scope.onAbort(() => { fired = true; });
    scope.dispose();
    parent.abort();
    // The scope's internal signal will still abort (AbortController propagation is async-free),
    // but the onAbort list was cleared. Behavior: dispose clears pending cleanups.
    expect(fired).toBe(false);
  });
});
