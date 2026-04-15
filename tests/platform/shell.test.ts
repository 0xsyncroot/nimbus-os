// tests/platform/shell.test.ts (SPEC-151 §6.1)

import { describe, expect, test } from 'bun:test';
import { cmdQuote, detectShell, pwshQuote } from '../../src/platform/shell.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

describe('SPEC-151: shell', () => {
  test('detectShell returns a supported kind', () => {
    const s = detectShell();
    expect(['bash', 'pwsh', 'cmd']).toContain(s.kind);
  });

  test('POSIX quote escapes spaces', () => {
    const s = detectShell();
    if (s.kind !== 'bash') return;
    expect(s.quote(['rm', 'a b'])).toBe("rm 'a b'");
  });

  test('POSIX quote neutralizes dollar sign and backtick (no command substitution)', () => {
    const s = detectShell();
    if (s.kind !== 'bash') return;
    const quoted = s.quote(['echo', '$(whoami)', '`id`']);
    // shell-quote escapes via backslash rather than single-quote wrapping; either way
    // the dangerous metacharacters must not appear unescaped.
    expect(/[^\\]\$\(whoami\)/.test(quoted)).toBe(false);
    expect(/[^\\]`id`/.test(quoted)).toBe(false);
    // And the raw tokens must not leak verbatim (un-escaped) at the start either.
    expect(quoted.startsWith('echo $(whoami)')).toBe(false);
  });

  test('pwsh quote doubles single quotes', () => {
    expect(pwshQuote("it's ok")).toBe("'it''s ok'");
  });

  test('pwsh quote leaves safe chars unquoted', () => {
    expect(pwshQuote('abc_123')).toBe('abc_123');
  });

  test('cmd quote wraps spaces in double quotes', () => {
    expect(cmdQuote('a b')).toBe('"a b"');
  });

  test('cmd quote rejects newlines', () => {
    try {
      cmdQuote('a\nb');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_INJECTION);
    }
  });

  test('null byte in arg throws X_INJECTION', () => {
    const s = detectShell();
    try {
      s.quote(['foo\0bar']);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.X_INJECTION);
    }
  });

  test('parseForAudit tokenizes POSIX-style command', () => {
    const s = detectShell();
    const toks = s.parseForAudit("echo 'hello world'");
    expect(toks[0]).toBe('echo');
    expect(toks[1]).toBe('hello world');
  });
});
