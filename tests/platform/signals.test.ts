// tests/platform/signals.test.ts (SPEC-151 §6.1)

import { afterEach, describe, expect, test } from 'bun:test';
import { __resetSignalSubscribers, onInterrupt, onTerminate } from '../../src/platform/signals.ts';

describe('SPEC-151: signals', () => {
  afterEach(() => {
    __resetSignalSubscribers();
  });

  test('onInterrupt fires on SIGINT', async () => {
    let hit = 0;
    onInterrupt(() => {
      hit += 1;
    });
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(hit).toBe(1);
  });

  test('unsubscribe removes listener', async () => {
    let hit = 0;
    const off = onInterrupt(() => {
      hit += 1;
    });
    off();
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(hit).toBe(0);
  });

  test('onTerminate fires on SIGTERM', async () => {
    let hit = 0;
    onTerminate(() => {
      hit += 1;
    });
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(hit).toBe(1);
  });

  test('a throwing callback does not break others', async () => {
    let good = 0;
    onInterrupt(() => {
      throw new Error('boom');
    });
    onInterrupt(() => {
      good += 1;
    });
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(good).toBe(1);
  });
});
