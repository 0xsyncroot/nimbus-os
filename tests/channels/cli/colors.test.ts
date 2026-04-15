import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { colors, stripAnsi, colorEnabled } from '../../../src/channels/cli/colors.ts';

describe('SPEC-801: colors + NO_COLOR', () => {
  const origNoColor = process.env['NO_COLOR'];
  const origForceColor = process.env['FORCE_COLOR'];
  afterEach(() => {
    if (origNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = origNoColor;
    if (origForceColor === undefined) delete process.env['FORCE_COLOR'];
    else process.env['FORCE_COLOR'] = origForceColor;
  });

  test('NO_COLOR=1 strips codes', () => {
    process.env['NO_COLOR'] = '1';
    delete process.env['FORCE_COLOR'];
    expect(colors.ok('hi')).toBe('hi');
    expect(colors.err('bad')).toBe('bad');
    expect(colorEnabled()).toBe(false);
  });

  test('FORCE_COLOR=1 emits ANSI', () => {
    delete process.env['NO_COLOR'];
    process.env['FORCE_COLOR'] = '1';
    const out = colors.ok('hi');
    expect(out).toContain('\x1b[');
    expect(stripAnsi(out)).toBe('hi');
  });

  test('stripAnsi handles mixed text', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m and \x1b[32mgreen\x1b[39m')).toBe('red and green');
  });
});
