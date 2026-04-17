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

// v0.3.12 confirmPick TTY — arrow+Enter only, no single-char shortcuts
// (shortcuts fired on buffered keystrokes from prior REPL line → auto-deny bug)
describe('SPEC-801 v0.3.12: confirmPick TTY path (arrow + Enter)', () => {
  test('Enter on default (Yes) → allow', async () => {
    const { input, output } = makeRawIO(['\r']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true);
  });

  test('arrow-down + Enter → deny (second item = No)', async () => {
    const { input, output } = makeRawIO(['\u001b[B', '\r']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(false);
  });

  test('Ctrl-C → returns boolean (ignored by pickOne without allowSkip → default allow)', async () => {
    const { input, output } = makeRawIO(['\u0003']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(typeof ok).toBe('boolean');
  });

  test('Regression: stray "n" byte does NOT auto-deny (no shortcut dispatch)', async () => {
    // v0.3.11 bug: "n" from buffered "tiếp tục nhỉ" leaked into confirmPick
    // → shortcut "n" auto-denied without rendering full menu.
    // v0.3.12 removed shortcuts. Stray "n" is ignored; Enter acts on default.
    const { input, output } = makeRawIO(['n', '\r']);
    const ok = await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(ok).toBe(true); // default Yes stays selected; 'n' ignored, Enter confirms
  });

  test('no double-echo artefact in output', async () => {
    const { input, output } = makeRawIO(['\r']);
    await confirm('go?', { input, output, timeoutMs: 5000 });
    expect(output.captured).not.toContain('yy');
  });
});
