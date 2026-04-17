// tests/platform/keyPromptCore.test.ts (SPEC-850 §6.1)

import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { readKeyFromStdin, promptMaskedKey } from '../../src/platform/keyPromptCore.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sinkOutput(): Writable & { captured: string } {
  const out = new Writable({
    write(chunk, _enc, cb) {
      (out as Writable & { captured: string }).captured += chunk.toString();
      cb();
    },
  }) as Writable & { captured: string };
  out.captured = '';
  return out;
}

/**
 * Build a fake TTY ReadStream that emits `data` events from `bytes` and
 * exposes `isTTY = true` + a no-op `setRawMode`.
 */
function fakeTtyStream(bytes: string): NodeJS.ReadStream {
  const s = new Readable({ read() {} }) as NodeJS.ReadStream;
  (s as unknown as { isTTY: boolean }).isTTY = true;
  (s as unknown as { isRaw: boolean }).isRaw = false;
  (s as unknown as { setRawMode: (v: boolean) => NodeJS.ReadStream }).setRawMode = (_v: boolean) => s;
  // Emit data synchronously after one microtask so listeners are attached first.
  Promise.resolve().then(() => {
    s.emit('data', bytes);
  });
  return s;
}

// ---------------------------------------------------------------------------
// readKeyFromStdin
// ---------------------------------------------------------------------------

describe('SPEC-850: readKeyFromStdin', () => {
  test('pipe input round-trip: stream end resolves with trimmed value', async () => {
    const stream = Readable.from(['sk-ant-piped-12345678901234567890\n']);
    const value = await readKeyFromStdin(stream as unknown as NodeJS.ReadStream);
    expect(value).toBe('sk-ant-piped-12345678901234567890');
  });

  test('rejects empty stdin with U_BAD_COMMAND.empty_stdin_key', async () => {
    const stream = Readable.from(['']);
    let err: unknown = null;
    try {
      await readKeyFromStdin(stream as unknown as NodeJS.ReadStream);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    expect((err as NimbusError).context['reason']).toBe('empty_stdin_key');
  });

  test('multi-chunk pipe input is concatenated', async () => {
    async function* gen(): AsyncGenerator<string> {
      yield 'sk-ant-';
      yield 'chunked-key';
    }
    const stream = Readable.from(gen());
    const value = await readKeyFromStdin(stream as unknown as NodeJS.ReadStream);
    expect(value).toBe('sk-ant-chunked-key');
  });
});

// ---------------------------------------------------------------------------
// promptMaskedKey
// ---------------------------------------------------------------------------

describe('SPEC-850: promptMaskedKey', () => {
  test('non-TTY input rejects with U_BAD_COMMAND.non_interactive', async () => {
    const fakeStdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const out = sinkOutput();
    let err: unknown = null;
    try {
      await promptMaskedKey({ prompt: 'key: ', input: fakeStdin, output: out });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    expect((err as NimbusError).context['reason']).toBe('non_interactive');
    expect(String((err as NimbusError).context['hint'])).toContain('--key-stdin');
  });

  test('masked TTY: result is correct and stdout never writes plaintext', async () => {
    const input = fakeTtyStream('sk-abc123\n');
    const out = sinkOutput();

    const result = await promptMaskedKey({ prompt: 'key: ', input, output: out });

    expect(result).toBe('sk-abc123');
    // Output must not contain the raw key characters as a substring
    expect(out.captured).not.toContain('sk-abc123');
    // Output should contain one '*' per non-control character (9 chars)
    const stars = (out.captured.match(/\*/g) ?? []).length;
    expect(stars).toBe(9);
  });

  test('backspace: ab\\x7Fc → result "ac"', async () => {
    // 'a', 'b', DEL (0x7F), 'c', Enter
    const input = fakeTtyStream('ab\x7Fc\r');
    const out = sinkOutput();

    const result = await promptMaskedKey({ prompt: '', input, output: out });
    expect(result).toBe('ac');
    // Backspace-space-backspace sequence written once for the 'b' deletion
    expect(out.captured).toContain('\b \b');
    // 3 stars written total (a, b, c) — the 'b' star is visually erased via \b \b
    // but the byte stream still contains all writes
    const stars = (out.captured.match(/\*/g) ?? []).length;
    expect(stars).toBe(3);
  });

  test('paste with embedded newline truncates at first newline', async () => {
    // Paste "sk-abc\nsk-extra" — only "sk-abc" should be returned
    const input = fakeTtyStream('sk-abc\nsk-extra');
    const out = sinkOutput();

    const result = await promptMaskedKey({ prompt: '', input, output: out });
    expect(result).toBe('sk-abc');
    expect(result).not.toContain('extra');
  });

  test('empty input rejected with U_MISSING_CONFIG.empty_key', async () => {
    const input = fakeTtyStream('\r');
    const out = sinkOutput();
    let err: unknown = null;
    try {
      await promptMaskedKey({ prompt: '', input, output: out });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_MISSING_CONFIG);
    expect((err as NimbusError).context['reason']).toBe('empty_key');
  });

  test('allowEmpty: empty input resolves with empty string', async () => {
    const input = fakeTtyStream('\r');
    const out = sinkOutput();

    const result = await promptMaskedKey({ prompt: '', input, output: out, allowEmpty: true });
    expect(result).toBe('');
  });

  test('Ctrl-C rejects with U_BAD_COMMAND.cancelled', async () => {
    const input = fakeTtyStream('\x03');
    const out = sinkOutput();
    let err: unknown = null;
    try {
      await promptMaskedKey({ prompt: '', input, output: out });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    expect((err as NimbusError).context['reason']).toBe('cancelled');
    // Output must NOT contain any raw key fragments
    expect(out.captured).not.toContain('\x03');
  });
});
