// idleHeartbeat.test.ts — SPEC-117: unit tests for idle heartbeat monitor.

import { describe, expect, test, beforeEach } from 'bun:test';
import { createIdleMonitor, suggestionFor, DEFAULT_IDLE_DELAY_MS, type LastContext } from '../../../src/channels/cli/idleHeartbeat.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(): { output: string[]; stream: NodeJS.WritableStream } {
  const output: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      output.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { output, stream };
}

// ---------------------------------------------------------------------------
// suggestionFor
// ---------------------------------------------------------------------------

describe('SPEC-117: suggestionFor', () => {
  test('read context → file question', () => {
    expect(suggestionFor('read')).toContain('file');
  });

  test('error context → debug offer', () => {
    expect(suggestionFor('error')).toContain('debug');
  });

  test('fresh context → greeting', () => {
    expect(suggestionFor('fresh')).toContain('today');
  });

  test('default context → standing by', () => {
    expect(suggestionFor('default')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Disabled paths
// ---------------------------------------------------------------------------

describe('SPEC-117: disabled paths → no fire', () => {
  test('enabled=false → monitor does not write suggestion', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: false,
      delayMs: 10,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 30));
    monitor.stop();
    expect(output).toHaveLength(0);
  });

  test('isCI=true → monitor does not write suggestion', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 10,
      isTTY: true,
      isCI: true,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 30));
    monitor.stop();
    expect(output).toHaveLength(0);
  });

  test('isTTY=false → monitor does not write suggestion', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 10,
      isTTY: false,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 30));
    monitor.stop();
    expect(output).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timer fires after delay
// ---------------------------------------------------------------------------

describe('SPEC-117: timer fires after delay', () => {
  test('fires once after delayMs when active', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 20,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 50));
    monitor.stop();
    expect(output.length).toBeGreaterThanOrEqual(1);
    expect(output.join('')).toContain('[NIMBUS]');
  });

  test('fires at most once per idle cycle (no double-fire)', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 15,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 60));
    monitor.stop();
    // Should only have fired once (firedThisCycle flag prevents re-fire without reset)
    expect(output).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// reset() cancels pending timer
// ---------------------------------------------------------------------------

describe('SPEC-117: reset() cancels pending suggestion', () => {
  test('reset before timeout prevents firing', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 40,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    // Reset before the 40ms delay expires
    await new Promise(r => setTimeout(r, 15));
    monitor.reset();
    // Wait past the original 40ms delay — reset should have pushed it out
    await new Promise(r => setTimeout(r, 25));
    monitor.stop();
    // The reset should have prevented the original timer from firing within 40ms.
    // After reset, a new 40ms timer starts — total elapsed ~40ms. It should NOT have fired.
    expect(output).toHaveLength(0);
  });

  test('reset re-arms and fires after full delayMs again', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 25,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 10));
    monitor.reset(); // re-arm
    await new Promise(r => setTimeout(r, 40)); // wait past new delay
    monitor.stop();
    expect(output).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stop() cancels timer
// ---------------------------------------------------------------------------

describe('SPEC-117: stop() cancels timer', () => {
  test('stop before timeout leaves output empty', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 40,
      isTTY: true,
      isCI: false,
      output: stream,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 10));
    monitor.stop();
    await new Promise(r => setTimeout(r, 40)); // would have fired but stopped
    expect(output).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context-based suggestion
// ---------------------------------------------------------------------------

describe('SPEC-117: suggestion text based on last context', () => {
  test('getLastContext=read → file suggestion text', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 15,
      isTTY: true,
      isCI: false,
      output: stream,
      getLastContext: () => 'read' as LastContext,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 30));
    monitor.stop();
    expect(output.join('')).toContain('file');
  });

  test('getLastContext=error → debug suggestion text', async () => {
    const { output, stream } = makeOutput();
    const monitor = createIdleMonitor({
      enabled: true,
      delayMs: 15,
      isTTY: true,
      isCI: false,
      output: stream,
      getLastContext: () => 'error' as LastContext,
    });
    monitor.start();
    await new Promise(r => setTimeout(r, 30));
    monitor.stop();
    expect(output.join('')).toContain('debug');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_IDLE_DELAY_MS constant
// ---------------------------------------------------------------------------

describe('SPEC-117: DEFAULT_IDLE_DELAY_MS', () => {
  test('is 60000ms', () => {
    expect(DEFAULT_IDLE_DELAY_MS).toBe(60_000);
  });
});
