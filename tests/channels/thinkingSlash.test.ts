import { beforeEach, describe, expect, test } from 'bun:test';
import type { ReplContext } from '../../src/channels/cli/slashCommands';
import {
  dispatchSlash,
  registerDefaultCommands,
  __resetRegistry,
} from '../../src/channels/cli/slashCommands';

function makeCtx(): { ctx: ReplContext; lines: string[]; settings: { thinking?: string } } {
  const lines: string[] = [];
  const settings: { thinking?: string } = {};
  const ctx: ReplContext = {
    wsId: 'test',
    write: (l: string) => lines.push(l),
    setThinking: (effort) => {
      settings.thinking = effort;
    },
    currentThinking: () => (settings.thinking as never) ?? null,
  };
  return { ctx, lines, settings };
}

beforeEach(() => {
  __resetRegistry();
  registerDefaultCommands();
});

describe('SPEC-206 T3: /thinking slash command', () => {
  test.each([
    ['/thinking off', 'off'],
    ['/thinking minimal', 'minimal'],
    ['/thinking low', 'low'],
    ['/thinking medium', 'medium'],
    ['/thinking high', 'high'],
    ['/thinking on', 'medium'],
    ['/thinking HIGH', 'high'],
  ])('%s sets setting to %s', async (cmd, expected) => {
    const { ctx, lines, settings } = makeCtx();
    await dispatchSlash(cmd, ctx);
    expect(settings.thinking).toBe(expected);
    expect(lines.some((l) => l.includes(`thinking set to ${expected}`))).toBe(true);
  });

  test('/thinking (no arg) shows current', async () => {
    const { ctx, lines, settings } = makeCtx();
    settings.thinking = 'high';
    await dispatchSlash('/thinking', ctx);
    expect(lines.some((l) => l.includes('thinking: high'))).toBe(true);
  });

  test('/thinking (no arg, not set) shows auto', async () => {
    const { ctx, lines } = makeCtx();
    await dispatchSlash('/thinking', ctx);
    expect(lines.some((l) => l.includes('auto — cue-driven'))).toBe(true);
  });

  test.each(['/thinking xhigh', '/thinking ultra', '/thinking DROP TABLE', '/thinking normal'])(
    '%s → U_BAD_COMMAND surfaced',
    async (cmd) => {
      const { ctx, lines, settings } = makeCtx();
      await dispatchSlash(cmd, ctx);
      expect(settings.thinking).toBeUndefined();
      // dispatchSlash catches NimbusError and writes an error line.
      expect(lines.some((l) => l.includes('U_BAD_COMMAND'))).toBe(true);
      expect(lines.some((l) => l.includes('invalid_thinking_arg'))).toBe(true);
    },
  );
});
