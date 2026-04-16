// credentialDetector.ts — SPEC-124: detect + redact credentials before JSONL write.

export interface CredentialMatch {
  kind:
    | 'openai-key'
    | 'anthropic-key'
    | 'telegram-bot-token'
    | 'slack-bearer'
    | 'generic-jwt'
    | 'bearer';
  span: { start: number; end: number };
  redacted: string; // always '***credential*** (saved to vault)'
}

const REDACTED = '***credential*** (saved to vault)';

// Each entry: [kind, regex]. All regexes require structural delimiter or keyword prefix.
const PATTERNS: Array<[CredentialMatch['kind'], RegExp]> = [
  // Anthropic before OpenAI (more specific prefix)
  ['anthropic-key', /sk-ant-[A-Za-z0-9\-_]{20,}/g],
  // OpenAI
  ['openai-key', /sk-[A-Za-z0-9]{20,}/g],
  // Telegram: 8-12 digits, colon, 35 chars (structural colon delimiter)
  ['telegram-bot-token', /\d{8,12}:[A-Za-z0-9_\-]{35}/g],
  // Slack bot token (structural prefix + numeric segments)
  ['slack-bearer', /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}/g],
  // JWT: three Base64url parts separated by dots (structural dot separator)
  ['generic-jwt', /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g],
  // Generic Bearer header (keyword prefix)
  ['bearer', /Bearer [A-Za-z0-9\-_.~+/]{20,}/g],
];

export function detectCredentials(text: string): CredentialMatch[] {
  const matches: CredentialMatch[] = [];
  for (const [kind, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      matches.push({
        kind,
        span: { start: m.index, end: m.index + m[0].length },
        redacted: REDACTED,
      });
    }
  }
  // Sort by start position for deterministic replacement
  matches.sort((a, b) => a.span.start - b.span.start);
  return matches;
}

export function redactSpans(text: string, matches: CredentialMatch[]): string {
  if (matches.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.span.start > cursor) {
      parts.push(text.slice(cursor, match.span.start));
    }
    parts.push(REDACTED);
    cursor = match.span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
