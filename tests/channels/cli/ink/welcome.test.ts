// welcome.test.ts — SPEC-853: Unit tests for <Welcome> Ink banner.
// Covers: wide, compact, plain variants + freshness detection + version + workspace/model.

import { describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/channels/cli/ink/theme.ts';
import { Welcome, isFreshSession } from '../../../../src/channels/cli/ink/components/Welcome.tsx';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const VERSION = '0.3.21-alpha';
const WORKSPACE = 'personal';
const MODEL = 'claude-sonnet-4-6';

function makeProps(overrides: Partial<Parameters<typeof Welcome>[0]> = {}): Parameters<typeof Welcome>[0] {
  return {
    version: VERSION,
    freshSession: false,
    noColor: false,
    cols: 120,
    workspace: WORKSPACE,
    model: MODEL,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

// ── SPEC-853 T1: Wide variant ──────────────────────────────────────────────────

describe('SPEC-853: Welcome — wide variant', () => {
  test('renders ASCII banner at cols=120, freshSession=false', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: false })),
      ),
    );
    const frame = lastFrame() ?? '';
    // ASCII banner has box-drawing chars
    expect(frame).toContain('█');
    expect(frame).toContain('╗');
  });

  test('wide: contains version string', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(VERSION);
  });

  test('wide: contains workspace name', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(WORKSPACE);
  });

  test('wide: contains model string', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(MODEL);
  });

  test('wide: contains hint text', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain('What can I help with today?');
  });

  test('wide: also renders at cols=70, freshSession=false', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 70, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain('█');
  });
});

// ── SPEC-853 T2: Compact variant ───────────────────────────────────────────────

describe('SPEC-853: Welcome — compact variant', () => {
  test('renders compact at cols=60 (isTight boundary)', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 60, freshSession: false })),
      ),
    );
    const frame = lastFrame() ?? '';
    // compact shows "nimbus" text but no full ASCII banner (no ███)
    expect(frame).toContain('nimbus');
    expect(frame).not.toContain('███');
  });

  test('renders compact when freshSession=true, cols=120', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: true })),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('nimbus');
    expect(frame).not.toContain('███');
  });

  test('compact: version present', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 60, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(VERSION);
  });

  test('compact: workspace name present', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 60, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(WORKSPACE);
  });

  test('compact: model present', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 60, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain(MODEL);
  });

  test('compact: hint present', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 60, freshSession: false })),
      ),
    );
    expect(lastFrame()).toContain('What can I help with today?');
  });
});

// ── SPEC-853 T3: Plain fallback ────────────────────────────────────────────────

describe('SPEC-853: Welcome — plain fallback', () => {
  test('renders plain when noColor=true', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(Welcome, makeProps({ noColor: true, cols: 120 })),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[OK] nimbus');
    expect(frame).not.toContain('███');
  });

  test('renders plain when cols=30', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 30 })),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[OK] nimbus');
    expect(frame).not.toContain('███');
  });

  test('plain: contains version', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(Welcome, makeProps({ noColor: true, cols: 120 })),
      ),
    );
    expect(lastFrame()).toContain(VERSION);
  });

  test('plain: contains workspace name', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(Welcome, makeProps({ noColor: true, cols: 120 })),
      ),
    );
    expect(lastFrame()).toContain(WORKSPACE);
  });

  test('plain: contains model', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(Welcome, makeProps({ noColor: true, cols: 120 })),
      ),
    );
    expect(lastFrame()).toContain(MODEL);
  });

  test('plain: NO_COLOR=1 — no box-drawing chars', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark-ansi' },
        React.createElement(Welcome, makeProps({ noColor: true, cols: 120 })),
      ),
    );
    const frame = lastFrame() ?? '';
    // No box-drawing chars from ASCII banner
    expect(frame).not.toContain('███');
    expect(frame).not.toContain('╗');
  });
});

// ── SPEC-853 T4: Freshness helper ─────────────────────────────────────────────

describe('SPEC-853: isFreshSession()', () => {
  test('returns false when lastBootAt is undefined', () => {
    expect(isFreshSession(undefined)).toBe(false);
  });

  test('returns false for timestamp >5 minutes ago', () => {
    const stale = Math.floor(Date.now() / 1000) - 400;
    expect(isFreshSession(stale)).toBe(false);
  });

  test('returns true for timestamp <5 minutes ago', () => {
    const fresh = Math.floor(Date.now() / 1000) - 60;
    expect(isFreshSession(fresh)).toBe(true);
  });

  test('boundary: exactly 300s ago → not fresh', () => {
    const boundary = Math.floor(Date.now() / 1000) - 300;
    expect(isFreshSession(boundary)).toBe(false);
  });

  test('boundary: 299s ago → fresh', () => {
    const fresh = Math.floor(Date.now() / 1000) - 299;
    expect(isFreshSession(fresh)).toBe(true);
  });

  test('two boots within 5min → compact (freshSession=true)', () => {
    const recent = Math.floor(Date.now() / 1000) - 120;
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: isFreshSession(recent) })),
      ),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('nimbus');
    expect(frame).not.toContain('███');
  });

  test('boot after >5min gap → wide (freshSession=false)', () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { name: 'dark' },
        React.createElement(Welcome, makeProps({ cols: 120, freshSession: isFreshSession(stale) })),
      ),
    );
    expect(lastFrame()).toContain('█');
  });
});
