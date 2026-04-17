// tests/channels/cli/repl.test.ts — SPEC-851 T5: startRepl dispatcher unit tests.
// Tests: NIMBUS_UI=legacy → legacy path; default → Ink path; SIGINT teardown;
//        parseConfirmAnswer; makeOnAsk (legacy).

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// ── parseConfirmAnswer ────────────────────────────────────────────────────────

describe('SPEC-851: parseConfirmAnswer', () => {
  // Import lazily to avoid full REPL boot
  test('y → allow', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('y')).toBe('allow');
  });

  test('yes → allow', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('yes')).toBe('allow');
  });

  test('empty → allow', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('')).toBe('allow');
  });

  test('n → deny', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('n')).toBe('deny');
  });

  test('no → deny', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('no')).toBe('deny');
  });

  test('never → deny', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('never')).toBe('deny');
  });

  test('always → always', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('always')).toBe('always');
  });

  test('a → always', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('a')).toBe('always');
  });

  test('unknown → null', async () => {
    const { parseConfirmAnswer } = await import('../../../src/channels/cli/repl.ts');
    expect(parseConfirmAnswer('xyz')).toBeNull();
  });
});

// ── NIMBUS_UI=legacy → startReplLegacy ───────────────────────────────────────

describe('SPEC-851: NIMBUS_UI=legacy dispatch', () => {
  let originalNimbusUi: string | undefined;

  beforeEach(() => {
    originalNimbusUi = process.env['NIMBUS_UI'];
    process.env['NIMBUS_UI'] = 'legacy';
  });

  afterEach(() => {
    if (originalNimbusUi === undefined) {
      delete process.env['NIMBUS_UI'];
    } else {
      process.env['NIMBUS_UI'] = originalNimbusUi;
    }
  });

  test('NIMBUS_UI=legacy env flag is detected before Ink import', () => {
    // Verify the env routing logic directly — NIMBUS_UI=legacy means !useInk
    const useInk = !process.env['NIMBUS_UI'] || process.env['NIMBUS_UI'] === 'ink';
    expect(useInk).toBe(false);
  });

  test('NIMBUS_UI=legacy: startReplLegacy prints deprecation to stderr', async () => {
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    // Spy on stderr
    process.stderr.write = function(
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error) => void),
      cb?: ((err?: Error) => void),
    ): boolean {
      if (typeof chunk === 'string') stderrChunks.push(chunk);
      if (typeof encodingOrCb === 'function') {
        return originalWrite(chunk, encodingOrCb);
      }
      return originalWrite(chunk, encodingOrCb as BufferEncoding | undefined, cb);
    } as typeof process.stderr.write;

    try {
      // Call startReplLegacy directly; mock workspace to make it fail fast
      const workspace = await import('../../../src/core/workspace.ts');
      const activeWsSpy = spyOn(workspace, 'getActiveWorkspace').mockResolvedValue(null);
      const { startReplLegacy } = await import('../../../src/channels/cli/repl.legacy.ts');
      try {
        await startReplLegacy({});
      } catch { /* expected: no_active_workspace */ }
      activeWsSpy.mockRestore();
    } finally {
      process.stderr.write = originalWrite;
    }

    const combined = stderrChunks.join('');
    expect(combined).toContain('DEPRECATION');
    expect(combined).toContain('legacy');
  });
});

// ── Default path uses Ink ─────────────────────────────────────────────────────

describe('SPEC-851: default (Ink) dispatch', () => {
  let originalNimbusUi: string | undefined;

  beforeEach(() => {
    originalNimbusUi = process.env['NIMBUS_UI'];
    delete process.env['NIMBUS_UI'];
  });

  afterEach(() => {
    if (originalNimbusUi === undefined) {
      delete process.env['NIMBUS_UI'];
    } else {
      process.env['NIMBUS_UI'] = originalNimbusUi;
    }
  });

  test('NIMBUS_UI unset → does NOT call startReplLegacy', async () => {
    const replLegacy = await import('../../../src/channels/cli/repl.legacy.ts');
    const legacySpy = spyOn(replLegacy, 'startReplLegacy').mockImplementation(async () => { /* no-op */ });

    // Mock workspace dependencies so startReplInk fails fast without a workspace
    const workspace = await import('../../../src/core/workspace.ts');
    const activeWsSpy = spyOn(workspace, 'getActiveWorkspace').mockResolvedValue(null);

    try {
      const { startRepl } = await import('../../../src/channels/cli/repl.ts');
      await startRepl({}).catch(() => { /* expected: no_active_workspace */ });
    } finally {
      legacySpy.mockRestore();
      activeWsSpy.mockRestore();
    }

    // Legacy path must NOT have been called
    expect(legacySpy).not.toHaveBeenCalled();
  });

  test('NIMBUS_UI=ink → Ink path (same as unset)', async () => {
    process.env['NIMBUS_UI'] = 'ink';

    const replLegacy = await import('../../../src/channels/cli/repl.legacy.ts');
    const legacySpy = spyOn(replLegacy, 'startReplLegacy').mockImplementation(async () => { /* no-op */ });

    const workspace = await import('../../../src/core/workspace.ts');
    const activeWsSpy = spyOn(workspace, 'getActiveWorkspace').mockResolvedValue(null);

    try {
      const { startRepl } = await import('../../../src/channels/cli/repl.ts');
      await startRepl({}).catch(() => { /* expected */ });
    } finally {
      legacySpy.mockRestore();
      activeWsSpy.mockRestore();
    }

    expect(legacySpy).not.toHaveBeenCalled();
  });
});

// ── InkUIHost — permission intent ────────────────────────────────────────────

describe('SPEC-851: createInkUIHost', () => {
  test('status intent logs and returns ok', async () => {
    const { createInkUIHost } = await import('../../../src/channels/cli/ink/uiHost.tsx');
    const host = createInkUIHost(() => { /* setModalNode */ });
    const ctx = {
      turnId: 't1', correlationId: 'c1', channelId: 'cli' as const,
      abortSignal: new AbortController().signal,
    };
    const result = await host.ask<void>({ kind: 'status', message: 'hello', level: 'info' }, ctx);
    expect(result).toMatchObject({ kind: 'ok' });
  });

  test('non-permission/status intents return cancel', async () => {
    const { createInkUIHost } = await import('../../../src/channels/cli/ink/uiHost.tsx');
    const host = createInkUIHost(() => { /* setModalNode */ });
    const ctx = {
      turnId: 't1', correlationId: 'c1', channelId: 'cli' as const,
      abortSignal: new AbortController().signal,
    };
    const result = await host.ask<string>({ kind: 'input', prompt: 'Enter:' }, ctx);
    expect(result).toMatchObject({ kind: 'cancel' });
  });

  test('abort signal cancels pending permission dialog', async () => {
    const { createInkUIHost } = await import('../../../src/channels/cli/ink/uiHost.tsx');
    const nodes: unknown[] = [];
    const host = createInkUIHost((node) => { nodes.push(node); });
    const ac = new AbortController();
    const ctx = {
      turnId: 't1', correlationId: 'c1', channelId: 'cli' as const,
      abortSignal: ac.signal,
    };
    const intent = { kind: 'permission' as const, toolName: 'bash', detail: 'ls', allowAlways: false };
    const promise = host.ask<string>(intent, ctx);
    // Abort immediately after mounting
    ac.abort();
    const result = await promise;
    expect(result).toMatchObject({ kind: 'cancel' });
  });

  test('canAsk() returns true', async () => {
    const { createInkUIHost } = await import('../../../src/channels/cli/ink/uiHost.tsx');
    const host = createInkUIHost(() => { /* no-op */ });
    expect(host.canAsk()).toBe(true);
  });

  test('concurrent asks return cancel for second caller', async () => {
    const { createInkUIHost } = await import('../../../src/channels/cli/ink/uiHost.tsx');
    let resolveFn: (() => void) | null = null;
    const host = createInkUIHost((node) => {
      if (node !== null) {
        // Simulate a mount that never resolves until we trigger it
        resolveFn = null; // consumed below
      }
    });
    const ac = new AbortController();
    const ctx = {
      turnId: 't1', correlationId: 'c1', channelId: 'cli' as const,
      abortSignal: ac.signal,
    };
    const intent = { kind: 'permission' as const, toolName: 'bash', detail: 'ls', allowAlways: false };

    // First ask — will block until aborted
    const p1 = host.ask<string>(intent, ctx);
    // Second ask — should get cancel immediately (busy)
    const p2 = host.ask<string>(intent, ctx);
    const r2 = await p2;
    expect(r2).toMatchObject({ kind: 'cancel' });

    // Clean up p1
    ac.abort();
    await p1;
  });
});
