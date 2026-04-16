import { describe, test, expect } from 'bun:test';
import { createOutboundQueue } from '../../src/channels/common/outboundQueue.ts';

describe('SPEC-802: OutboundQueue', () => {
  test('FIFO order preserved', async () => {
    const q = createOutboundQueue({ maxSize: 100 });
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = i;
      q.enqueue(async () => { order.push(n); });
    }
    await q.drain();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test('overflow (enqueue 600 items, maxSize=500) drops oldest 100', async () => {
    const q = createOutboundQueue({ maxSize: 500 });
    const executed: number[] = [];

    // enqueue 600 tasks synchronously (no await between enqueues)
    for (let i = 0; i < 600; i++) {
      const n = i;
      q.enqueue(async () => { executed.push(n); });
    }

    await q.drain();

    // Should have executed at most 500 tasks (oldest 100 dropped).
    // Because task 0 runs before overflow happens (concurrency=1, starts immediately),
    // we may have 501 total. The spec says "oldest dropped" from the waiting queue.
    // Tolerance: between 500 and 501 executed.
    expect(executed.length).toBeGreaterThanOrEqual(500);
    expect(executed.length).toBeLessThanOrEqual(501);

    // The last 500 items in execution should be from i=100..599 or i=0,100..599.
    // At minimum, the item 599 must be present (most recently enqueued).
    expect(executed).toContain(599);
  });

  test('enqueue returns synchronously (no async blocking)', () => {
    const q = createOutboundQueue();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      q.enqueue(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });
    }
    const elapsed = performance.now() - start;
    // 1000 enqueues should be <<1s even with heavy tasks queued
    expect(elapsed).toBeLessThan(50);
  });

  test('drain resolves when queue is empty', async () => {
    const q = createOutboundQueue();
    let done = false;
    q.enqueue(async () => { done = true; });
    await q.drain();
    expect(done).toBe(true);
  });

  test('drain resolves immediately when nothing queued', async () => {
    const q = createOutboundQueue();
    await expect(q.drain()).resolves.toBeUndefined();
  });

  test('task errors do not break subsequent tasks', async () => {
    const q = createOutboundQueue();
    const results: string[] = [];
    q.enqueue(async () => { throw new Error('boom'); });
    q.enqueue(async () => { results.push('ok'); });
    await q.drain();
    expect(results).toEqual(['ok']);
  });

  test('maxConcurrency=1 ensures serial execution', async () => {
    const q = createOutboundQueue({ maxConcurrency: 1 });
    let concurrent = 0;
    let maxConcurrent = 0;
    for (let i = 0; i < 5; i++) {
      q.enqueue(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((r) => setTimeout(r, 1));
        concurrent--;
      });
    }
    await q.drain();
    expect(maxConcurrent).toBe(1);
  });
});
