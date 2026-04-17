// ErrorDialog.test.tsx — SPEC-852: unit tests for <ErrorDialog> component.
// Tests: code badge, localized message, doctor hint, NO_COLOR, narrow, ANSI strip, secret mask.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ThemeProvider } from '../../../../../src/channels/cli/ink/theme.ts';
import { ErrorDialog, stripAnsi, maskSecrets } from '../../../../../src/channels/cli/ink/components/ErrorDialog.tsx';
import { NimbusError, ErrorCode } from '../../../../../src/observability/errors.ts';

afterEach(() => {
  cleanup();
});

// ── Helper to render with theme ────────────────────────────────────────────────
function renderDialog(props: React.ComponentProps<typeof ErrorDialog>) {
  return render(
    React.createElement(
      ThemeProvider,
      { name: 'dark' },
      React.createElement(ErrorDialog, props),
    ),
  );
}

// ── SPEC-852 T1: core render ───────────────────────────────────────────────────
describe('SPEC-852: ErrorDialog — core render', () => {
  test('renders error code badge T_VALIDATION', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, { reason: 'bad_input' });
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('T_VALIDATION');
  });

  test('renders friendly summary for T_VALIDATION (not raw JSON)', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, { reason: 'bad_input' });
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    // No raw JSON serialization — no quoted key names like "reason":"..."
    expect(frame).not.toContain('"reason"');
    expect(frame).not.toContain('{"reason"');
    // Should contain friendly summary from formatError
    expect(frame).toContain('Input looks malformed');
    expect(frame.length).toBeGreaterThan(0);
  });

  test('does NOT show doctor hint for T_VALIDATION (tool error, not system/security)', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, {});
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('nimbus doctor');
  });

  test('renders doctor hint for Y_OOM (system error)', () => {
    const err = new NimbusError(ErrorCode.Y_OOM, {});
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Y_OOM');
    expect(frame).toContain('nimbus doctor');
  });

  test('renders doctor hint for X_BASH_BLOCKED (security error)', () => {
    const err = new NimbusError(ErrorCode.X_BASH_BLOCKED, { reason: 'policy' });
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('X_BASH_BLOCKED');
    expect(frame).toContain('nimbus doctor');
  });
});

// ── SPEC-852: ANSI-OSC strip ───────────────────────────────────────────────────
describe('SPEC-852: ErrorDialog — ANSI escape stripping', () => {
  test('stripAnsi removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[2Jhello')).toBe('hello');
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  test('stripAnsi removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain');
  });

  test('stripAnsi is identity on safe strings', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  test('error context with ANSI escape is safe in render (not wipe-screen)', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, { reason: '\x1b[2J' });
    // Should not throw, and frame should not contain raw ESC sequence
    const { lastFrame } = renderDialog({ error: err });
    const frame = lastFrame() ?? '';
    // The component may show context; ESC char should not appear
    expect(frame).not.toContain('\x1b[2J');
  });
});

// ── SPEC-852: Secret masking ───────────────────────────────────────────────────
describe('SPEC-852: ErrorDialog — secret masking (HARD RULE §10)', () => {
  test('maskSecrets masks apiKey field', () => {
    const result = maskSecrets({ apiKey: 'sk-abc1234567890' });
    expect(result['apiKey']).toMatch(/sk-\*\*\*\*/);
    expect(result['apiKey']).not.toContain('sk-abc123456789');
  });

  test('maskSecrets masks token field', () => {
    const result = maskSecrets({ token: 'ghp_secrettoken' });
    expect(result['token']).toMatch(/sk-\*\*\*\*/);
  });

  test('maskSecrets masks passphrase field', () => {
    const result = maskSecrets({ passphrase: 'hunter2' });
    expect(result['passphrase']).toMatch(/sk-\*\*\*\*/);
  });

  test('maskSecrets preserves safe fields (stripped of ANSI)', () => {
    const result = maskSecrets({ reason: 'bad_input', field: 'name' });
    expect(result['reason']).toBe('bad_input');
    expect(result['field']).toBe('name');
  });

  test('maskSecrets strips ANSI from non-secret fields', () => {
    const result = maskSecrets({ reason: '\x1b[31mred\x1b[0m' });
    expect(result['reason']).toBe('red');
  });
});

// ── SPEC-852: NO_COLOR branch ──────────────────────────────────────────────────
describe('SPEC-852: ErrorDialog — NO_COLOR branch', () => {
  test('NO_COLOR=true: renders plain text without box-drawing characters', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, {});
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        { name: 'dark-ansi' },
        React.createElement(ErrorDialog, { error: err, noColor: true }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('T_VALIDATION');
    // No box-drawing characters (╭, ╰, │, etc.)
    expect(frame).not.toMatch(/[╭╰╮╯│─]/);
  });

  test('NO_COLOR=true: renders summary text', () => {
    const err = new NimbusError(ErrorCode.P_AUTH, {});
    const { lastFrame } = render(
      React.createElement(
        ThemeProvider,
        { name: 'dark-ansi' },
        React.createElement(ErrorDialog, { error: err, noColor: true }),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain('P_AUTH');
  });
});

// ── SPEC-852: Narrow terminal branch ──────────────────────────────────────────
describe('SPEC-852: ErrorDialog — narrow terminal (cols < 60)', () => {
  test('cols=50: no border rendered, single-line format', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, {});
    const { lastFrame } = renderDialog({ error: err, cols: 50 });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('T_VALIDATION');
    expect(frame).not.toMatch(/[╭╰╮╯│─]/);
  });

  test('cols=80: bordered output includes code badge', () => {
    const err = new NimbusError(ErrorCode.T_VALIDATION, {});
    const { lastFrame } = renderDialog({ error: err, cols: 80 });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('T_VALIDATION');
  });
});

// ── SPEC-852: No raw JSON.stringify in source files ────────────────────────────
describe('SPEC-852: Integration — no raw JSON.stringify(err.context) in call sites', () => {
  test('render.ts does not contain JSON.stringify(err.context)', async () => {
    const src = await Bun.file(
      new URL('../../../../../src/channels/cli/render.ts', import.meta.url),
    ).text();
    expect(src).not.toContain('JSON.stringify(err.context)');
  });

  test('slashCommands.ts does not contain JSON.stringify(err.context)', async () => {
    const src = await Bun.file(
      new URL('../../../../../src/channels/cli/slashCommands.ts', import.meta.url),
    ).text();
    expect(src).not.toContain('JSON.stringify(err.context)');
  });
});
