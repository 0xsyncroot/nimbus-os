// welcome.test.ts — SPEC-824 T5: snapshot tests + variant selector + width assertions.
// v0.3.1 snapshots deleted (superseded by SPEC-824 redesign).
// New: wide-80, stacked-50, compact, plain snapshots + property test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { pickVariant, renderWelcome, type WelcomeInput } from '../../../src/channels/cli/welcome.ts';
import { LAYOUT_WIDE_MIN, stripAnsi } from '../../../src/channels/cli/colors.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<WelcomeInput> = {}): WelcomeInput {
  return {
    wsName: 'my-workspace',
    model: 'claude-sonnet-4-6',
    providerKind: 'anthropic',
    cols: 80,
    isTTY: true,
    noColor: false,
    ...overrides,
  };
}

function assertWidth(output: string, cols: number): void {
  for (const line of output.split('\n')) {
    const visible = stripAnsi(line).length;
    expect(visible).toBeLessThanOrEqual(cols);
  }
}

// ---------------------------------------------------------------------------
// Env cleanup
// ---------------------------------------------------------------------------

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR', 'TERM', 'NIMBUS_FORCE_WELCOME'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // Force color on for tests that need it
  process.env['FORCE_COLOR'] = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env['FORCE_COLOR'];
});

// ---------------------------------------------------------------------------
// pickVariant — SPEC-824 T4: narrow cutoff now cols<40 (was <60)
// ---------------------------------------------------------------------------

describe('SPEC-824: pickVariant', () => {
  test('first-run → full', () => {
    expect(pickVariant(baseInput({ numStartups: 1, isTTY: true, noColor: false }))).toBe('full');
  });

  test('no startups field → full', () => {
    expect(pickVariant(baseInput({ numStartups: undefined, isTTY: true, noColor: false }))).toBe('full');
  });

  test('>5min gap → full', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 400;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: true, noColor: false }))).toBe('full');
  });

  test('<5min gap → compact (rapid reopens only)', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 60;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: true, noColor: false }))).toBe('compact');
  });

  // SPEC-824 T4: cutoff now cols<40 (not <60)
  test('cols=39 with TTY → plain', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, cols: 39, isTTY: true, noColor: false }))).toBe('plain');
  });

  test('cols=40 with TTY → compact (not plain)', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, cols: 40, isTTY: true, noColor: false }))).toBe('compact');
  });

  test('NO_COLOR → plain', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, noColor: true }))).toBe('plain');
  });

  test('!isTTY → plain', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: false, noColor: false }))).toBe('plain');
  });

  test('force="full" overrides', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, force: 'full' }))).toBe('full');
  });

  test('force="plain" overrides compact', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: true, noColor: false, force: 'plain' }))).toBe('plain');
  });

  test('NIMBUS_FORCE_WELCOME=compact overrides first-run', () => {
    process.env['NIMBUS_FORCE_WELCOME'] = 'compact';
    expect(pickVariant(baseInput({ numStartups: 1, isTTY: true, noColor: false }))).toBe('compact');
  });
});

// ---------------------------------------------------------------------------
// SPEC-824 snapshot: wide-80 layout (2-column with mascot)
// ---------------------------------------------------------------------------

describe('SPEC-824: wide-80 layout (full, cols=80)', () => {
  test('contains mascot block char ░', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    expect(out).toContain('░');
  });

  test('each line fits cols=80', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    assertWidth(out, 80);
  });

  test('contains workspace name', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', wsName: 'alpha', cols: 80 }));
    expect(stripAnsi(out)).toContain('alpha');
  });

  test('contains model', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', model: 'claude-opus-4-5', cols: 80 }));
    expect(stripAnsi(out)).toContain('claude-opus-4-5');
  });

  test('contains /help footer', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    expect(stripAnsi(out)).toContain('/help');
  });

  test(`uses wide layout when cols >= ${LAYOUT_WIDE_MIN}`, () => {
    expect(LAYOUT_WIDE_MIN).toBe(70);
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    // Wide layout: mascot lines preceded by 3 spaces (WIDE_PADDING_L)
    const lines = out.split('\n').filter((l) => stripAnsi(l).trim().length > 0);
    // At least one line should start with 3 spaces (the left padding)
    const hasPadded = lines.some((l) => stripAnsi(l).startsWith('   '));
    expect(hasPadded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SPEC-824 snapshot: stacked-50 layout (mascot above text)
// ---------------------------------------------------------------------------

describe('SPEC-824: stacked-50 layout (full, cols=50)', () => {
  test('contains mascot block char ░', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 50 }));
    expect(out).toContain('░');
  });

  test('each line fits cols=50', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 50 }));
    assertWidth(out, 50);
  });

  test('contains workspace name', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', wsName: 'dev-ws', cols: 50 }));
    expect(stripAnsi(out)).toContain('dev-ws');
  });

  test('contains /help footer', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 50 }));
    expect(stripAnsi(out)).toContain('/help');
  });

  test('has more lines than wide layout (mascot stacked above text)', () => {
    const stacked = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 50 }));
    const wide = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    const stackedLines = stacked.split('\n').filter((l) => l.length > 0).length;
    const wideLines = wide.split('\n').filter((l) => l.length > 0).length;
    expect(stackedLines).toBeGreaterThan(wideLines);
  });
});

// ---------------------------------------------------------------------------
// SPEC-824 snapshot: compact variant (single line)
// ---------------------------------------------------------------------------

describe('SPEC-824: compact variant', () => {
  test('produces exactly 1 non-empty line', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact' }));
    const nonEmpty = out.split('\n').filter((l) => l.length > 0);
    expect(nonEmpty).toHaveLength(1);
  });

  test('fits cols=80', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', cols: 80 }));
    assertWidth(out, 80);
  });

  test('contains workspace name + model', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', wsName: 'dev', model: 'gpt-4o' }));
    const plain = stripAnsi(out);
    expect(plain).toContain('dev');
    expect(plain).toContain('gpt-4o');
  });

  test('contains /help hint', () => {
    const out = renderWelcome(baseInput({ force: 'compact' }));
    expect(stripAnsi(out)).toContain('/help');
  });
});

// ---------------------------------------------------------------------------
// SPEC-824 snapshot: plain variant
// ---------------------------------------------------------------------------

describe('SPEC-824: plain variant', () => {
  test('starts with [OK]', () => {
    const out = renderWelcome(baseInput({ force: 'plain', noColor: true }));
    expect(out.startsWith('[OK]')).toBe(true);
  });

  test('no ANSI in output', () => {
    const out = renderWelcome(baseInput({ force: 'plain', noColor: true }));
    expect(stripAnsi(out)).toBe(out);
  });

  test('contains workspace name', () => {
    const out = renderWelcome(baseInput({ force: 'plain', wsName: 'test-ws', noColor: true }));
    expect(out).toContain('test-ws');
  });

  test('contains model', () => {
    const out = renderWelcome(baseInput({ force: 'plain', model: 'gemini-pro', noColor: true }));
    expect(out).toContain('gemini-pro');
  });
});

// ---------------------------------------------------------------------------
// SPEC-824: property test — stripAnsi(line).length ≤ cols for cols in [35, 50, 80, 120]
// ---------------------------------------------------------------------------

describe('SPEC-824: width property test', () => {
  const colSizes = [35, 50, 80, 120];

  for (const cols of colSizes) {
    test(`all lines fit within cols=${cols} (full variant)`, () => {
      const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols }));
      assertWidth(out, cols);
    });

    test(`all lines fit within cols=${cols} (compact variant)`, () => {
      const lastBootAt = Math.floor(Date.now() / 1000) - 100;
      const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', cols }));
      assertWidth(out, cols);
    });

    test(`plain variant cols=${cols}: output is script-safe single line`, () => {
      const out = renderWelcome(baseInput({ force: 'plain', noColor: true, cols }));
      // Plain is script-compat fixed output — check it's a single non-empty line
      const lines = out.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith('[OK]')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// NO_COLOR regression: EARTH_* functions return ''
// ---------------------------------------------------------------------------

describe('SPEC-824: NO_COLOR strips ANSI', () => {
  test('compact output has no ANSI under NO_COLOR', () => {
    process.env['NO_COLOR'] = '1';
    delete process.env['FORCE_COLOR'];
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', noColor: true }));
    expect(stripAnsi(out)).toBe(out);
  });

  test('full output has no ANSI under NO_COLOR', () => {
    process.env['NO_COLOR'] = '1';
    delete process.env['FORCE_COLOR'];
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', noColor: true }));
    expect(stripAnsi(out)).toBe(out);
  });
});

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

describe('SPEC-824: performance', () => {
  test('renderWelcome is synchronous and fast', () => {
    const input = baseInput({ numStartups: 1, force: 'full', cols: 80 });
    const start = performance.now();
    for (let i = 0; i < 100; i++) renderWelcome(input);
    const avg = (performance.now() - start) / 100;
    expect(avg).toBeLessThan(10);
  });
});
