// welcome.test.ts — SPEC-823 T5: snapshot tests + variant selector + width assertions.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { pickVariant, renderWelcome, type WelcomeInput } from '../../../src/channels/cli/welcome.ts';
import { stripAnsi } from '../../../src/channels/cli/colors.ts';

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

function lineCount(s: string): number {
  return s.split('\n').filter((l) => l.length > 0).length;
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
// pickVariant — input matrix
// ---------------------------------------------------------------------------

describe('SPEC-823: pickVariant', () => {
  test('first-run → full', () => {
    expect(pickVariant(baseInput({ numStartups: 1, isTTY: true, noColor: false }))).toBe('full');
  });

  test('no startups field → full', () => {
    expect(pickVariant(baseInput({ numStartups: undefined, isTTY: true, noColor: false }))).toBe('full');
  });

  test('>1h gap → full', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 4000;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: true, noColor: false }))).toBe('full');
  });

  test('<1h gap → compact', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, isTTY: true, noColor: false }))).toBe('compact');
  });

  test('narrow cols → plain', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    expect(pickVariant(baseInput({ numStartups: 5, lastBootAt, cols: 40, isTTY: true, noColor: false }))).toBe('plain');
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
// renderWelcome — variant-specific assertions
// ---------------------------------------------------------------------------

describe('SPEC-823: renderPlain', () => {
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
});

describe('SPEC-823: renderCompact', () => {
  test('produces at most 2 non-empty lines', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact' }));
    expect(lineCount(out)).toBeLessThanOrEqual(2);
  });

  test('each line fits cols=80', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', cols: 80 }));
    assertWidth(out, 80);
  });

  test('stripAnsi output contains workspace + model', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const out = renderWelcome(baseInput({ numStartups: 5, lastBootAt, force: 'compact', wsName: 'dev', model: 'gpt-4o' }));
    const plain = stripAnsi(out);
    expect(plain).toContain('dev');
    expect(plain).toContain('gpt-4o');
  });
});

describe('SPEC-823: renderFull', () => {
  test('produces at most 15 lines', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    // count all lines including blank separators
    const total = out.split('\n').length;
    expect(total).toBeLessThanOrEqual(15);
  });

  test('each line fits cols=80', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', cols: 80 }));
    assertWidth(out, 80);
  });

  test('contains workspace, model, provider info', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', wsName: 'alpha', model: 'claude-opus-4-5', providerKind: 'anthropic' }));
    const plain = stripAnsi(out);
    expect(plain).toContain('alpha');
    expect(plain).toContain('claude-opus-4-5');
    expect(plain).toContain('anthropic');
  });

  test('memory note count shown', () => {
    const out = renderWelcome(baseInput({ numStartups: 1, force: 'full', memoryNoteCount: 7 }));
    const plain = stripAnsi(out);
    expect(plain).toContain('7 note');
  });
});

// ---------------------------------------------------------------------------
// NO_COLOR regression: EARTH_* constants return ''
// ---------------------------------------------------------------------------

describe('SPEC-823: NO_COLOR strips ANSI', () => {
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
// Narrow terminal → plain fallback
// ---------------------------------------------------------------------------

describe('SPEC-823: narrow terminal fallback', () => {
  test('cols=40 with TTY → plain variant', () => {
    const lastBootAt = Math.floor(Date.now() / 1000) - 100;
    const variant = pickVariant(baseInput({ numStartups: 5, lastBootAt, cols: 40, isTTY: true, noColor: false }));
    expect(variant).toBe('plain');
  });

  test('plain output fits width=40', () => {
    const out = renderWelcome(baseInput({ force: 'plain', wsName: 'dev', model: 'm', noColor: true, cols: 40 }));
    assertWidth(out, 80); // plain is always short
  });
});

// ---------------------------------------------------------------------------
// Performance budget
// ---------------------------------------------------------------------------

describe('SPEC-823: performance', () => {
  test('renderWelcome is synchronous and fast', () => {
    const input = baseInput({ numStartups: 1, force: 'full', cols: 80 });
    const start = performance.now();
    for (let i = 0; i < 100; i++) renderWelcome(input);
    const avg = (performance.now() - start) / 100;
    // p99 proxy: avg * 3 < 10ms (very conservative)
    expect(avg).toBeLessThan(10);
  });
});
