// ErrorDialog.tsx — SPEC-852: Ink <ErrorDialog> replaces raw JSON error dump.
// Renders a rounded-border alert with code badge, localized message, and optional
// "run nimbus doctor" hint for system/security errors (Y_* + X_*).
// NO_COLOR / narrow-terminal branches degrade gracefully.

import React from 'react';
import { Box, Text } from 'ink';
import type { NimbusError } from '../../../../observability/errors.ts';
import { formatError } from '../../../../observability/errorFormat.ts';
import { useTheme } from '../theme.ts';

// ── ANSI-OSC strip ─────────────────────────────────────────────────────────────
// Untrusted error context may contain malicious escape sequences.
// Strip all ESC-based sequences (CSI, OSC, private, etc.) from a string.
// Pattern covers:
//   - CSI sequences: ESC [ ... final-byte
//   - OSC sequences: ESC ] ... ST (ST = BEL \x07 or ESC \)
//   - Single-char ESC sequences: ESC + any char in 0x40–0x5F range
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b]*(?:\x07|\x1b\\)|[@-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── Secret masking — HARD RULE §10 ────────────────────────────────────────────
// Field names matching *key, *token, *passphrase (case-insensitive) are masked.
const SECRET_FIELD_RE = /key|token|passphrase|password|secret/i;

export function maskSecrets(ctx: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SECRET_FIELD_RE.test(k)) {
      const raw = String(v);
      // Show last 4 chars so users can correlate which key it is.
      const tail = raw.length > 4 ? raw.slice(-4) : '****';
      out[k] = `sk-****${tail}`;
    } else {
      out[k] = stripAnsi(String(v));
    }
  }
  return out;
}

// ── Doctor hint — shown for X_* (security) and Y_* (system) codes only ────────
function showDoctorHint(code: string): boolean {
  return code.startsWith('X_') || code.startsWith('Y_');
}

// ── Props ──────────────────────────────────────────────────────────────────────
export interface ErrorDialogProps {
  error: NimbusError;
  /** Passed from AppContext; triggers NO_COLOR branch */
  noColor?: boolean;
  /** Terminal columns; triggers narrow branch at <60 */
  cols?: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ErrorDialog({ error, noColor = false, cols }: ErrorDialogProps): React.ReactElement {
  const getColor = useTheme();
  const errorColor = getColor('error');

  const { summary, action } = formatError(error);
  const code = error.code;
  const showHint = showDoctorHint(code);
  const maskedCtx = maskSecrets(error.context);
  const ctxKeys = Object.keys(maskedCtx).filter((k) => maskedCtx[k] !== 'undefined');

  // ── Narrow terminal branch (cols < 60) ────────────────────────────────────
  const isNarrow = typeof cols === 'number' && cols < 60;
  if (isNarrow || noColor) {
    // No border, single-line or plain text format
    const line = `[${code}] ${summary}${action ? ` ${action}` : ''}`;
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, line),
      showHint
        ? React.createElement(Text, null, '  Try: run nimbus doctor')
        : null,
    );
  }

  // ── Full bordered dialog ───────────────────────────────────────────────────
  const colorProp = errorColor !== '' ? errorColor : undefined;

  return React.createElement(
    Box,
    {
      borderStyle: 'round',
      borderColor: colorProp,
      flexDirection: 'column',
      paddingX: 1,
    },
    // Header: code badge + summary
    React.createElement(
      Box,
      { flexDirection: 'row', gap: 1 },
      React.createElement(Text, { color: colorProp, bold: true }, `[${code}]`),
      React.createElement(Text, { bold: true }, summary),
    ),
    // Action line
    action
      ? React.createElement(
          Box,
          { paddingLeft: 2 },
          React.createElement(Text, { dimColor: true }, action),
        )
      : null,
    // Context detail lines (masked + ANSI-stripped)
    ctxKeys.length > 0
      ? React.createElement(
          Box,
          { paddingLeft: 2, flexDirection: 'column' },
          ...ctxKeys.map((k) =>
            React.createElement(Text, { key: k, dimColor: true }, `${k}: ${maskedCtx[k]}`),
          ),
        )
      : null,
    // Footer: doctor hint for system/security errors
    showHint
      ? React.createElement(
          Box,
          { paddingLeft: 2 },
          React.createElement(
            Text,
            { color: colorProp },
            'Hint: run \`nimbus doctor\` to diagnose environment issues.',
          ),
        )
      : null,
  );
}
