// cliHost.test.ts — SPEC-832 T5: unit tests for createCliUIHost.
// Tests: id+supports, canAsk, confirm delegation, pick delegation, status write,
//        lock contention (U_UI_BUSY), abort signal cancellation.

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createCliUIHost } from '../../../../src/channels/cli/ui/cliHost.ts';
import { ErrorCode, NimbusError } from '../../../../src/observability/errors.ts';
import type { UIContext } from '../../../../src/core/ui/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<UIContext>): UIContext {
  return {
    turnId: 'turn-1',
    correlationId: 'corr-1',
    channelId: 'cli',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

/** Minimal writable stream that captures output. */
function makeOutputStream() {
  const chunks: string[] = [];
  const stream = {
    write: (s: string) => { chunks.push(s); return true; },
    isTTY: true as boolean | undefined,
    get output() { return chunks.join(''); },
    get lines() { return chunks; },
  };
  return stream as unknown as NodeJS.WriteStream & { output: string; lines: string[] };
}

/** Minimal readable that is never read from (tests don't need real stdin). */
function makeInputStream(isTTY = true): NodeJS.ReadableStream & { setRawMode?: (r: boolean) => unknown; isTTY?: boolean } {
  return {
    isTTY,
    setRawMode: mock(() => undefined),
    on: mock(() => undefined as unknown as NodeJS.ReadableStream),
    off: mock(() => undefined as unknown as NodeJS.ReadableStream),
    once: mock(() => undefined as unknown as NodeJS.ReadableStream),
    resume: mock(() => undefined as unknown as NodeJS.ReadableStream),
    pause: mock(() => undefined as unknown as NodeJS.ReadableStream),
    read: mock(() => null),
    pipe: mock(() => undefined as unknown as NodeJS.WritableStream),
    unpipe: mock(() => undefined as unknown as NodeJS.ReadableStream),
    removeAllListeners: mock(() => undefined as unknown as NodeJS.ReadableStream),
    emit: mock(() => false),
    removeListener: mock(() => undefined as unknown as NodeJS.ReadableStream),
    addListener: mock(() => undefined as unknown as NodeJS.ReadableStream),
    eventNames: mock(() => [] as (string | symbol)[]),
    listenerCount: mock(() => 0),
    listeners: mock(() => []),
    rawListeners: mock(() => []),
    prependListener: mock(() => undefined as unknown as NodeJS.ReadableStream),
    prependOnceListener: mock(() => undefined as unknown as NodeJS.ReadableStream),
    setMaxListeners: mock(() => undefined as unknown as NodeJS.ReadableStream),
    getMaxListeners: mock(() => 0),
    [Symbol.asyncIterator]: mock(() => ({
      next: async () => ({ done: true as const, value: undefined }),
    })),
  } as unknown as NodeJS.ReadableStream & { setRawMode?: (r: boolean) => unknown; isTTY?: boolean };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPEC-832: createCliUIHost', () => {
  it('returns UIHost with id="cli" and correct supports set', () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: true,
      colorEnabled: false,
    });
    expect(host.id).toBe('cli');
    expect(host.supports).toContain('confirm');
    expect(host.supports).toContain('pick');
    expect(host.supports).toContain('input');
    expect(host.supports).toContain('status');
  });

  it('canAsk() returns true when isTTY=true', () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(true),
      stdout,
      isTTY: true,
      colorEnabled: false,
    });
    expect(host.canAsk()).toBe(true);
  });

  it('canAsk() returns false when isTTY=false', () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(false),
      stdout,
      isTTY: false,
      colorEnabled: false,
    });
    expect(host.canAsk()).toBe(false);
  });

  it('status intent writes message to stdout and resolves ok immediately', async () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,
      colorEnabled: false,
    });
    const ctx = makeContext();
    const result = await host.ask({ kind: 'status', message: 'hello world', level: 'info' }, ctx);
    expect(result.kind).toBe('ok');
    expect(stdout.output).toContain('hello world');
  });

  it('status intent includes level prefix in output', async () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,
      colorEnabled: false,
    });
    const ctx = makeContext();
    await host.ask({ kind: 'status', message: 'bad thing', level: 'error' }, ctx);
    expect(stdout.output).toContain('[ERR]');
    expect(stdout.output).toContain('bad thing');
  });

  it('status intent with colorEnabled=true uses ANSI codes', async () => {
    const stdout = makeOutputStream();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,
      colorEnabled: true,
    });
    const ctx = makeContext();
    await host.ask({ kind: 'status', message: 'notice', level: 'warn' }, ctx);
    // ANSI escape prefix present
    expect(stdout.output).toContain('\x1b[');
    expect(stdout.output).toContain('notice');
  });

  it('throws U_UI_BUSY when a second ask() fires while first is in-flight', async () => {
    const stdout = makeOutputStream();
    // Use an AbortController we can abort to unblock the first ask
    const ac = new AbortController();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,  // non-TTY so confirm falls through to cancel immediately (aborted)
      colorEnabled: false,
    });

    // Start a first ask that will hang until abort
    const first = host.ask(
      { kind: 'confirm', prompt: 'first?' },
      makeContext({ abortSignal: ac.signal }),
    );

    // A second concurrent ask must throw U_UI_BUSY
    let caughtCode: string | undefined;
    try {
      await host.ask(
        { kind: 'confirm', prompt: 'second?' },
        makeContext({ abortSignal: new AbortController().signal }),
      );
    } catch (err) {
      if (err instanceof NimbusError) caughtCode = err.code;
    }

    // Abort the first one to clean up
    ac.abort();
    await first.catch(() => undefined);

    expect(caughtCode).toBe(ErrorCode.U_UI_BUSY);
  });

  it('abort signal on confirm returns cancel result', async () => {
    const stdout = makeOutputStream();
    const ac = new AbortController();
    ac.abort(); // pre-aborted
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,
      colorEnabled: false,
    });
    const result = await host.ask(
      { kind: 'confirm', prompt: 'allow?' },
      makeContext({ abortSignal: ac.signal }),
    );
    expect(result.kind).toBe('cancel');
  });

  it('abort signal on pick returns cancel result', async () => {
    const stdout = makeOutputStream();
    const ac = new AbortController();
    ac.abort();
    const host = createCliUIHost({
      stdin: makeInputStream(),
      stdout,
      isTTY: false,
      colorEnabled: false,
    });
    const result = await host.ask(
      { kind: 'pick', prompt: 'choose', options: [{ id: 'a', label: 'A' }] },
      makeContext({ abortSignal: ac.signal }),
    );
    expect(result.kind).toBe('cancel');
  });
});
