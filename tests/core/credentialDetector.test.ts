import { describe, expect, test } from 'bun:test';
import { detectCredentials, redactSpans } from '../../src/core/credentialDetector.ts';
import { redactBeforeWrite, redactBeforeWriteDetailed } from '../../src/observability/redactor.ts';

const REDACTED = '***credential*** (saved to vault)';

// ─── Positive fixtures ───────────────────────────────────────────────────────

describe('SPEC-124: credentialDetector — positive fixtures', () => {
  test('detects OpenAI key (sk-...)', () => {
    const text = 'api key is sk-abcdefghijklmnopqrstu1234 for the service';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.kind).toBe('openai-key');
    expect(matches[0]!.redacted).toBe(REDACTED);
  });

  test('detects Anthropic key (sk-ant-...)', () => {
    const text = 'key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz-123456789ABCDEF';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.kind).toBe('anthropic-key');
  });

  test('detects Telegram bot token (NNNN:AAxxxxxxxxx)', () => {
    const text = 'token 1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx kết nối đi';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.kind).toBe('telegram-bot-token');
  });

  test('detects Slack bot token (xoxb-...)', () => {
    // Synthetic fixture — GitHub push protection flags real-looking tokens.
    // Shape only: xoxb- + digits + letters; not a valid issued token.
    const text = 'SLACK_BOT_TOKEN=' + 'xoxb-' + '0000000000-0000000000-' + 'PLACEHOLDERFIXTUREONLYTOKEN';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.kind).toBe('slack-bearer');
  });

  test('detects generic JWT (three-part eyJ...)', () => {
    const text = 'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(1);
    expect(matches[0]!.kind).toBe('generic-jwt');
  });

  test('detects Bearer token header', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk';
    const matches = detectCredentials(text);
    // generic-jwt matches the eyJ part, bearer matches "Bearer eyJ..."
    // At least one match, and bearer should be present
    const kinds = matches.map((m) => m.kind);
    expect(kinds).toContain('bearer');
  });

  test('detects multiple credentials in one text', () => {
    const text = 'openai=sk-abcdefghijklmnopqrstu1234 telegram=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const matches = detectCredentials(text);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const kinds = matches.map((m) => m.kind);
    expect(kinds).toContain('openai-key');
    expect(kinds).toContain('telegram-bot-token');
  });
});

// ─── Negative fixtures ───────────────────────────────────────────────────────

describe('SPEC-124: credentialDetector — negative fixtures', () => {
  test('does NOT flag a 40-char random alphanumeric string', () => {
    const text = 'hash: a3f9b2c7d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(0);
  });

  test('does NOT flag a UUID', () => {
    const text = 'id: 550e8400-e29b-41d4-a716-446655440000';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(0);
  });

  test('does NOT flag a 32-char alphanum without prefix', () => {
    const text = 'token: AbCdEfGhIjKlMnOpQrStUvWxYz123456';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(0);
  });

  test('does NOT flag a short sk- string (under 20 chars)', () => {
    const text = 'option: sk-shortkey';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(0);
  });
});

// ─── redactSpans ─────────────────────────────────────────────────────────────

describe('SPEC-124: redactSpans', () => {
  test('replaces matched span with REDACTED placeholder', () => {
    const text = 'key sk-abcdefghijklmnopqrstu1234 ok';
    const matches = detectCredentials(text);
    const result = redactSpans(text, matches);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstu1234');
    expect(result).toContain(REDACTED);
    expect(result).toContain('key');
    expect(result).toContain('ok');
  });

  test('handles empty matches array (no-op)', () => {
    const text = 'nothing sensitive here';
    expect(redactSpans(text, [])).toBe(text);
  });

  test('replaces multiple spans correctly (positions do not shift)', () => {
    const text = 'a=sk-abcdefghijklmnopqrstu1234 b=sk-zyxwvutsrqponmlkjihg5678';
    const matches = detectCredentials(text);
    expect(matches.length).toBe(2);
    const result = redactSpans(text, matches);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstu1234');
    expect(result).not.toContain('sk-zyxwvutsrqponmlkjihg5678');
    // Two REDACTED placeholders in the output
    expect(result.split(REDACTED).length - 1).toBe(2);
  });

  test('preserves surrounding text outside matched spans', () => {
    const text = 'before sk-abcdefghijklmnopqrstu1234 after';
    const matches = detectCredentials(text);
    const result = redactSpans(text, matches);
    expect(result.startsWith('before ')).toBe(true);
    expect(result.endsWith(' after')).toBe(true);
  });
});

// ─── redactBeforeWrite ───────────────────────────────────────────────────────

describe('SPEC-124: redactBeforeWrite (JSONL hook)', () => {
  test('redacts Telegram token from a raw session line', () => {
    const rawLine = JSON.stringify({
      role: 'user',
      content: 'bot token 1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx kết nối đi',
    });
    const cleaned = redactBeforeWrite(rawLine);
    expect(cleaned).not.toContain('1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(cleaned).toContain(REDACTED);
  });

  test('returns original line unchanged when no credentials', () => {
    const rawLine = JSON.stringify({ role: 'user', content: 'hello world' });
    expect(redactBeforeWrite(rawLine)).toBe(rawLine);
  });

  test('redactBeforeWriteDetailed returns structured result', () => {
    const rawLine = JSON.stringify({ role: 'user', content: 'key=sk-abcdefghijklmnopqrstu1234' });
    const result = redactBeforeWriteDetailed(rawLine);
    expect(result.redacted).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.line).not.toContain('sk-abcdefghijklmnopqrstu1234');
  });

  test('redactBeforeWriteDetailed returns redacted=false for clean line', () => {
    const rawLine = '{"role":"assistant","content":"Hello!"}';
    const result = redactBeforeWriteDetailed(rawLine);
    expect(result.redacted).toBe(false);
    expect(result.count).toBe(0);
    expect(result.line).toBe(rawLine);
  });
});
