// mascot.test.ts — SPEC-824 T5: unit tests for renderMascot().

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MASCOT_HEIGHT, MASCOT_WIDTH, renderMascot } from '../../../src/channels/cli/mascot.ts';
import { stripAnsi } from '../../../src/channels/cli/colors.ts';

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR', 'TERM'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['FORCE_COLOR'] = '1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env['FORCE_COLOR'];
});

describe('SPEC-824: renderMascot', () => {
  test('returns exactly MASCOT_HEIGHT lines', () => {
    const lines = renderMascot();
    expect(lines).toHaveLength(MASCOT_HEIGHT);
    expect(MASCOT_HEIGHT).toBe(5);
  });

  test('MASCOT_WIDTH is 13', () => {
    expect(MASCOT_WIDTH).toBe(13);
  });

  test('each stripped line length is ≤ MASCOT_WIDTH', () => {
    const lines = renderMascot();
    for (const line of lines) {
      const visible = stripAnsi(line).length;
      expect(visible).toBeLessThanOrEqual(MASCOT_WIDTH);
    }
  });

  test('plain mode (NO_COLOR): no ANSI escapes in output', () => {
    delete process.env['FORCE_COLOR'];
    process.env['NO_COLOR'] = '1';
    const lines = renderMascot();
    for (const line of lines) {
      expect(stripAnsi(line)).toBe(line);
    }
  });

  test('color mode: lines contain ANSI escapes', () => {
    const lines = renderMascot();
    const hasAnsi = lines.some((l) => l !== stripAnsi(l));
    expect(hasAnsi).toBe(true);
  });
});
