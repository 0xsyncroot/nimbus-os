// redactor.ts — SPEC-124: synchronous JSONL write-path redaction hook.
// Called from session JSONL writer (SPEC-102 integration point) before append.
// Plaintext credentials must never reach disk.

import { detectCredentials, redactSpans } from '../core/credentialDetector.ts';
import { logger } from './logger.ts';

export interface RedactResult {
  line: string;
  redacted: boolean;
  count: number;
}

/**
 * Redact all credential spans from a raw JSONL line before it is written.
 * Emits a structured log event per match (no plaintext logged).
 * Returns the cleaned line (or original if no matches).
 */
export function redactBeforeWrite(rawLine: string): string {
  const matches = detectCredentials(rawLine);
  if (matches.length === 0) return rawLine;

  for (const match of matches) {
    logger.warn(
      { event: 'credential_detected', kind: match.kind },
      'credential span found in session line — redacting before write',
    );
  }

  return redactSpans(rawLine, matches);
}

/**
 * Detailed variant: returns structured result with redaction metadata.
 * Useful for callers that need to know if redaction occurred (e.g., tests).
 */
export function redactBeforeWriteDetailed(rawLine: string): RedactResult {
  const matches = detectCredentials(rawLine);
  if (matches.length === 0) return { line: rawLine, redacted: false, count: 0 };

  for (const match of matches) {
    logger.warn(
      { event: 'credential_detected', kind: match.kind },
      'credential span found in session line — redacting before write',
    );
  }

  return {
    line: redactSpans(rawLine, matches),
    redacted: true,
    count: matches.length,
  };
}
