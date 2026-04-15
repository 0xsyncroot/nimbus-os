// tests/onboard/keyPrompt.test.ts (SPEC-902 §6.1)

import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { promptApiKey, readKeyFromStdin } from '../../src/onboard/keyPrompt.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';
import { validateKeyFormat, KEY_FORMAT_PATTERNS } from '../../src/onboard/keyValidators.ts';

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

describe('SPEC-902: keyPrompt', () => {
  test('non-TTY input rejects with U_BAD_COMMAND.non_interactive', async () => {
    const fakeStdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const out = sinkOutput();
    let err: unknown = null;
    try {
      await promptApiKey({ provider: 'anthropic', input: fakeStdin, output: out });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    expect((err as NimbusError).context['reason']).toBe('non_interactive');
    // Hint must be actionable
    expect(String((err as NimbusError).context['hint'])).toContain('--key-stdin');
  });

  test('readKeyFromStdin reads piped key', async () => {
    const { Readable } = await import('node:stream');
    const stream = Readable.from(['sk-ant-piped-12345678901234567890\n']);
    const value = await readKeyFromStdin(stream as unknown as NodeJS.ReadStream);
    expect(value).toBe('sk-ant-piped-12345678901234567890');
  });

  test('readKeyFromStdin rejects empty', async () => {
    const { Readable } = await import('node:stream');
    const stream = Readable.from(['']);
    let err: unknown = null;
    try {
      await readKeyFromStdin(stream as unknown as NodeJS.ReadStream);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).context['reason']).toBe('empty_stdin_key');
  });
});

describe('SPEC-902: keyValidators', () => {
  test('anthropic format accepts sk-ant-*', () => {
    expect(() => validateKeyFormat('anthropic', 'sk-ant-' + 'A'.repeat(30))).not.toThrow();
  });

  test('anthropic rejects bare sk- key', () => {
    let err: unknown = null;
    try {
      validateKeyFormat('anthropic', 'sk-' + 'A'.repeat(30));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    // Context never carries the raw key
    expect(JSON.stringify((err as NimbusError).context)).not.toContain('AAAAAAAA');
  });

  test('openai accepts sk-proj- prefix', () => {
    expect(() =>
      validateKeyFormat('openai', 'sk-proj-' + 'A'.repeat(30)),
    ).not.toThrow();
  });

  test('groq accepts gsk_ prefix', () => {
    expect(() => validateKeyFormat('groq', 'gsk_' + 'A'.repeat(30))).not.toThrow();
  });

  test('deepseek accepts sk- prefix', () => {
    expect(() =>
      validateKeyFormat('deepseek', 'sk-' + 'A'.repeat(30)),
    ).not.toThrow();
  });

  test('ollama accepts any value (including empty)', () => {
    expect(() => validateKeyFormat('ollama', '')).not.toThrow();
    expect(() => validateKeyFormat('ollama', 'whatever')).not.toThrow();
  });

  test('unknown provider rejects with known list', () => {
    let err: unknown = null;
    try {
      validateKeyFormat('not-a-provider', 'sk-ant-x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NimbusError);
    expect((err as NimbusError).context['reason']).toBe('unknown_provider');
    expect(Array.isArray((err as NimbusError).context['known'])).toBe(true);
  });

  test('all 5 providers in KEY_FORMAT_PATTERNS', () => {
    for (const p of ['anthropic', 'openai', 'groq', 'deepseek', 'ollama']) {
      expect(KEY_FORMAT_PATTERNS[p]).toBeInstanceOf(RegExp);
    }
  });
});
