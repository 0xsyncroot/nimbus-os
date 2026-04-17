// repl.confirmReplExit.test.ts — v0.3.5 URGENT regression guard.
//
// Bug: after a tool confirm (makeOnAsk) completed, the CLI silently exited
// mid-REPL because node:readline.createInterface().close() paused stdin and
// the subsequent slashAutocomplete readLine() did not resume it. With no
// pending I/O, Bun emptied the event loop and exited with code 0.
//
// These tests verify the fix:
//  1. makeOnAsk reads y/n/always/never from a raw-mode 'data' stream without
//     pausing the underlying input.
//  2. After makeOnAsk resolves, a downstream listener on the SAME stdin-like
//     stream still receives keystrokes (simulates REPL autocomplete re-entry).
//  3. slashAutocomplete.readLine() explicitly resumes stdin on re-entry
//     (defense-in-depth against other pause sources).

import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { makeOnAsk, parseConfirmAnswer } from '../../../src/channels/cli/repl.ts';
import {
  createAutocomplete,
  type AutocompleteInput,
} from '../../../src/channels/cli/slashAutocomplete.ts';
import {
  __resetRegistry,
  registerDefaultCommands,
  listCommands,
} from '../../../src/channels/cli/slashCommands.ts';

/** Fake raw-capable stdin that tracks pause/resume and rawMode state. */
function makeFakeStdin(): {
  stream: PassThrough & AutocompleteInput & {
    setRawMode: (b: boolean) => unknown;
    resume: () => void;
    pause: () => void;
  };
  state: { rawMode: boolean; paused: boolean; resumeCalls: number };
} {
  const stream = new PassThrough() as PassThrough & AutocompleteInput;
  const state = { rawMode: false, paused: false, resumeCalls: 0 };
  (stream as PassThrough & { isTTY?: boolean }).isTTY = true;
  (stream as PassThrough & { setRawMode?: (b: boolean) => unknown }).setRawMode = (b: boolean) => {
    state.rawMode = b;
    return stream;
  };
  // Override pause/resume to record calls. Underlying PassThrough still works.
  const origPause = stream.pause.bind(stream);
  const origResume = stream.resume.bind(stream);
  stream.pause = () => {
    state.paused = true;
    return origPause();
  };
  stream.resume = () => {
    state.paused = false;
    state.resumeCalls += 1;
    return origResume();
  };
  return { stream: stream as PassThrough & AutocompleteInput & { setRawMode: (b: boolean) => unknown; resume: () => void; pause: () => void }, state };
}

function makeOutput(): { out: PassThrough; captured: () => string } {
  const out = new PassThrough();
  let buf = '';
  out.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
  return { out, captured: () => buf };
}

describe('v0.3.5: parseConfirmAnswer', () => {
  test('y / yes / empty → allow', () => {
    expect(parseConfirmAnswer('y')).toBe('allow');
    expect(parseConfirmAnswer('yes')).toBe('allow');
    expect(parseConfirmAnswer('')).toBe('allow'); // default-yes
  });
  test('n / no / never → deny', () => {
    expect(parseConfirmAnswer('n')).toBe('deny');
    expect(parseConfirmAnswer('no')).toBe('deny');
    expect(parseConfirmAnswer('never')).toBe('deny');
  });
  test('always / a → always', () => {
    expect(parseConfirmAnswer('always')).toBe('always');
    expect(parseConfirmAnswer('a')).toBe('always');
  });
});

describe('v0.3.12: makeOnAsk delegates to confirmPick (arrow + Enter, no shortcuts)', () => {
  test('Enter on default (Yes) → allow', async () => {
    const { stream } = makeFakeStdin();
    const { out } = makeOutput();
    const onAsk = makeOnAsk(stream, out, true);
    expect(onAsk).toBeDefined();

    const pending = onAsk!({ toolUseId: 't1', name: 'Write', input: { path: '/tmp/x.txt' } });
    await new Promise((r) => setImmediate(r));
    stream.write('\r');
    const decision = await pending;

    expect(decision).toBe('allow');
  });

  test('ArrowDown + Enter → deny', async () => {
    const { stream } = makeFakeStdin();
    const { out } = makeOutput();
    const onAsk = makeOnAsk(stream, out, true)!;
    const pending = onAsk({ toolUseId: 't2', name: 'Bash', input: { cmd: 'ls' } });
    await new Promise((r) => setImmediate(r));
    stream.write('\x1b[B'); // ArrowDown
    await new Promise((r) => setImmediate(r));
    stream.write('\r');
    expect(await pending).toBe('deny');
  });

  test('ArrowDown×2 + Enter → always', async () => {
    const { stream } = makeFakeStdin();
    const { out } = makeOutput();
    const onAsk = makeOnAsk(stream, out, true)!;
    const pending = onAsk({ toolUseId: 't3', name: 'Write', input: { path: '/tmp/y.txt' } });
    await new Promise((r) => setImmediate(r));
    stream.write('\x1b[B');
    await new Promise((r) => setImmediate(r));
    stream.write('\x1b[B');
    await new Promise((r) => setImmediate(r));
    stream.write('\r');
    expect(await pending).toBe('always');
  });

  test('Regression: "n" in buffered junk does NOT auto-deny (no shortcut dispatch)', async () => {
    const { stream } = makeFakeStdin();
    const { out } = makeOutput();
    const onAsk = makeOnAsk(stream, out, true)!;
    const pending = onAsk({ toolUseId: 't4', name: 'Write', input: { path: '/tmp/z.txt' } });
    await new Promise((r) => setImmediate(r));
    // Stray 'n' from a prior REPL line (e.g. "tiếp tục nhỉ" leftover byte)
    // used to fire the shortcut map and auto-deny. v0.3.12 removed shortcuts.
    stream.write('n');
    await new Promise((r) => setImmediate(r));
    stream.write('\r'); // User actually presses Enter → should be 'allow'
    expect(await pending).toBe('allow');
  });

  test('after resolve, new "data" listener still receives bytes (REPL can re-enter)', async () => {
    const { stream, state } = makeFakeStdin();
    const { out } = makeOutput();
    const onAsk = makeOnAsk(stream, out, true)!;

    // Round 1: prompt Enter (default Yes)
    const p1 = onAsk({ toolUseId: 'r1', name: 'Write', input: { path: '/a' } });
    await new Promise((r) => setImmediate(r));
    stream.write('\r');
    expect(await p1).toBe('allow');
    // Note: confirmPick pauses stdin on cleanup. Next reader (slashAutocomplete)
    // is responsible for calling resume() (SPEC-505 fix).
    stream.resume();

    // Round 2: simulate REPL re-attaching a listener (like slashAutocomplete.readLine).
    const received: string[] = [];
    const next = new Promise<void>((resolve) => {
      const h = (chunk: Buffer | string): void => {
        const t = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        received.push(t);
        if (t.includes('\r') || t.includes('\n')) {
          stream.removeListener('data', h);
          resolve();
        }
      };
      stream.on('data', h);
    });
    stream.write('hi\r');
    await next;
    expect(received.join('')).toContain('hi');
  });
});

describe('v0.3.5: slashAutocomplete defense-in-depth resume()', () => {
  // Send each char as a separate chunk so parseKey classifies it correctly
  // (multi-byte chunks are treated as 'paste' which doesn't fire Enter).
  function sendKeys(stream: PassThrough, keys: string): void {
    for (const ch of keys) stream.write(ch);
  }

  test('readLine() calls input.resume() on entry (even when stream already flowing)', async () => {
    __resetRegistry();
    registerDefaultCommands();
    const { stream, state } = makeFakeStdin();
    const { out } = makeOutput();
    const ac = createAutocomplete({
      input: stream,
      output: out,
      promptStr: () => '> ',
      commands: listCommands,
      cols: () => 80,
    });
    const pending = ac.readLine();
    await new Promise((r) => setImmediate(r));
    // resume() should have been called at least once during readLine() setup.
    expect(state.resumeCalls).toBeGreaterThanOrEqual(1);
    // Finish the line so we don't leak.
    sendKeys(stream, 'x\r');
    const result = await pending;
    expect(result).toBe('x');
    ac.dispose();
  });

  test('readLine() recovers if stream is paused beforehand (simulates post-onAsk)', async () => {
    __resetRegistry();
    registerDefaultCommands();
    const { stream, state } = makeFakeStdin();
    const { out } = makeOutput();
    // Simulate prior code pausing stdin (like node:readline close() does).
    stream.pause();
    expect(state.paused).toBe(true);

    const ac = createAutocomplete({
      input: stream,
      output: out,
      promptStr: () => '> ',
      commands: listCommands,
      cols: () => 80,
    });
    const pending = ac.readLine();
    await new Promise((r) => setImmediate(r));
    // After readLine() setup, stream must be resumed again.
    expect(state.paused).toBe(false);
    sendKeys(stream, 'x\r');
    expect(await pending).toBe('x');
    ac.dispose();
  });
});
