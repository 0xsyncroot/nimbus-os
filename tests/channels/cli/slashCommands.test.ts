import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetRegistry,
  dispatchSlash,
  parseSlash,
  registerDefaultCommands,
  registerSlash,
  listCommands,
} from '../../../src/channels/cli/slashCommands.ts';
import type { ReplContext } from '../../../src/channels/cli/slashCommands.ts';

function mockCtx(): { ctx: ReplContext; output: string[] } {
  const output: string[] = [];
  const ctx: ReplContext = {
    wsId: 'ws1',
    write: (s: string) => output.push(s),
  };
  return { ctx, output };
}

describe('SPEC-801: slashCommands', () => {
  beforeEach(() => {
    __resetRegistry();
  });

  test('parseSlash extracts name + args', () => {
    expect(parseSlash('/help')).toEqual({ name: 'help', args: '' });
    expect(parseSlash('/switch my-ws')).toEqual({ name: 'switch', args: 'my-ws' });
    expect(parseSlash('hello')).toBeNull();
    expect(parseSlash('/ ')).toBeNull();
  });

  test('dispatchSlash routes to handler', async () => {
    const { ctx, output } = mockCtx();
    let called = '';
    registerSlash({
      name: 'test',
      description: 't',
      usage: '/test',
      handler: (args) => {
        called = args;
      },
    });
    const handled = await dispatchSlash('/test foo bar', ctx);
    expect(handled).toBe(true);
    expect(called).toBe('foo bar');
    expect(output.length).toBe(0);
  });

  test('unknown command writes hint', async () => {
    const { ctx, output } = mockCtx();
    const handled = await dispatchSlash('/nope', ctx);
    expect(handled).toBe(true);
    expect(output.join('')).toContain('/nope');
  });

  test('non-slash returns false', async () => {
    const { ctx } = mockCtx();
    const handled = await dispatchSlash('plain message', ctx);
    expect(handled).toBe(false);
  });

  test('registerDefaultCommands includes 13 commands incl /mode', () => {
    registerDefaultCommands();
    const names = listCommands().map((c) => c.name);
    for (const expected of [
      'help', 'quit', 'stop', 'new', 'switch', 'workspaces',
      'soul', 'memory', 'provider', 'model', 'cost', 'spec-confirm', 'mode',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('/mode readonly calls setMode("readonly")', async () => {
    registerDefaultCommands();
    const { ctx, output } = mockCtx();
    let applied = null as string | null;
    ctx.setMode = (m) => { applied = m; };
    await dispatchSlash('/mode readonly', ctx);
    expect(applied).toBe('readonly');
    expect(output.join('')).not.toContain('Unknown command');
  });

  test('/mode default calls setMode("default")', async () => {
    registerDefaultCommands();
    const { ctx } = mockCtx();
    let applied = null as string | null;
    ctx.setMode = (m) => { applied = m; };
    await dispatchSlash('/mode default', ctx);
    expect(applied).toBe('default');
  });

  test('/mode (no arg) reports current mode', async () => {
    registerDefaultCommands();
    const { ctx, output } = mockCtx();
    ctx.currentMode = () => 'readonly';
    await dispatchSlash('/mode', ctx);
    expect(output.join('')).toContain('readonly');
  });

  test('/mode bypass at runtime shows warn, does not setMode', async () => {
    registerDefaultCommands();
    const { ctx, output } = mockCtx();
    let applied = null as string | null;
    ctx.setMode = (m) => { applied = m; };
    await dispatchSlash('/mode bypass', ctx);
    expect(applied).toBeNull();
    expect(output.join('').toLowerCase()).toContain('bypass');
  });

  test('/mode garbage shows usage, does not setMode', async () => {
    registerDefaultCommands();
    const { ctx, output } = mockCtx();
    let applied = null as string | null;
    ctx.setMode = (m) => { applied = m; };
    await dispatchSlash('/mode foo', ctx);
    expect(applied).toBeNull();
    expect(output.join('')).toContain('usage');
  });
});
