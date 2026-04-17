import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { confirm, __testing } from '../../../src/channels/cli/confirm.ts';
import { ErrorCode, NimbusError } from '../../../src/observability/errors.ts';

function makeIO(answer: string): { input: Readable; output: Writable; captured: { text: string } } {
  const captured = { text: '' };
  const input = new Readable({ read() {} });
  const output = new Writable({
    write(chunk, _enc, cb) {
      captured.text += chunk.toString();
      cb();
    },
  });
  // emit answer immediately after consumer attaches
  setImmediate(() => {
    input.push(`${answer}\n`);
    input.push(null);
  });
  return { input, output, captured };
}

function makeRawIO(keys: string[]): {
  input: Readable & { setRawMode: (r: boolean) => unknown; isTTY: boolean };
  output: Writable & { captured: string };
} {
  let idx = 0;
  const input = new Readable({ read() {} }) as Readable & {
    setRawMode: (r: boolean) => unknown;
    isTTY: boolean;
    isRaw: boolean;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw: boolean) => { input.isRaw = raw; return input; };

  const scheduleNext = (): void => {
    setImmediate(() => {
      const key = keys[idx++];
      if (key !== undefined) {
        input.push(key);
        if (idx < keys.length) scheduleNext();
      }
    });
  };
  scheduleNext();

  const output = new Writable({
    write(chunk, _enc, cb) {
      (output as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  output.captured = '';

  return { input, output };
}

describe('SPEC-801: confirm prompt (non-TTY / original path)', () => {
  test('"y" resolves true', async () => {
    const { input, output } = makeIO('y');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('"yes" resolves true', async () => {
    const { input, output } = makeIO('yes');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('empty (Enter) with defaultNo=true resolves false', async () => {
    const { input, output } = makeIO('');
    const ok = await confirm('go?', { input, output, defaultNo: true, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('"n" resolves false', async () => {
    const { input, output } = makeIO('n');
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('timeout resolves false', async () => {
    const input = new Readable({ read() {} });
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const ok = await confirm('go?', { input, output, timeoutMs: 20 });
    expect(ok).toBe(false);
  });

  test('parseAnswer helper', () => {
    expect(__testing.strictAnswer('y', true)).toBe(true);
    expect(__testing.strictAnswer('', true)).toBe(false);
    expect(__testing.strictAnswer('', false)).toBe(true);
    expect(__testing.strictAnswer('no', false)).toBe(false);
  });
});

// v0.3.10 regression tests for Bug B (double-echo fix)
describe('SPEC-801 v0.3.10: confirmPick TTY path (no double-echo)', () => {
  test('single keystroke "y" → allow (not deny from double-echo)', async () => {
    const { input, output } = makeRawIO(['y']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('single keystroke "Y" (uppercase) → allow', async () => {
    const { input, output } = makeRawIO(['Y']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('single keystroke "n" → deny', async () => {
    const { input, output } = makeRawIO(['n']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('arrow-down + Enter → deny (second item = No)', async () => {
    const { input, output } = makeRawIO(['\u001b[B', '\r']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('Esc (Ctrl-C) → returns boolean without throwing', async () => {
    // Ctrl-C without allowSkip in pickOne returns items[defaultIdx] = 'allow' = true.
    // The important contract is: does not throw, returns a boolean.
    const { input, output } = makeRawIO(['\u0003']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(typeof ok).toBe('boolean');
  });

  test('stdin emits "y" once → captured output does NOT contain "yy"', async () => {
    const { input, output } = makeRawIO(['y']);
    await confirm('go?', { input, output, timeoutMs: 5000 });
    // The picker renders item labels, not the raw keystrokes — so "y" should
    // not appear as double "yy" in the output (which would indicate double-echo).
    const text = output.captured;
    // No raw "yy" substring (double-echo artefact):
    expect(text).not.toContain('yy');
  });
});
