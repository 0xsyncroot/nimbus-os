// tests/channels/cli/slashKey.test.ts — SPEC-904 T5: /key slash command registration

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetRegistry,
  registerDefaultCommands,
  listCommands,
  getCommand,
} from '../../../src/channels/cli/slashCommands.ts';

beforeEach(() => {
  __resetRegistry();
  registerDefaultCommands();
});

describe('SPEC-904: /key slash command', () => {
  test('is registered after registerDefaultCommands', () => {
    const cmd = getCommand('key');
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('key');
    expect(cmd?.category).toBe('workspace');
  });

  test('appears in listCommands output', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('key');
  });

  test('description mentions key management', () => {
    const cmd = getCommand('key');
    expect(cmd?.description.toLowerCase()).toMatch(/key/);
  });

  test('handler is a function', () => {
    const cmd = getCommand('key');
    expect(typeof cmd?.handler).toBe('function');
  });
});
