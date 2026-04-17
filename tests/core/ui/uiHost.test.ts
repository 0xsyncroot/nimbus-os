// uiHost.test.ts — SPEC-830: UIHost interface + NullUIHost sentinel tests.

import { describe, expect, test } from 'bun:test';
import { NullUIHost, type UIHost } from '../../../src/core/ui/uiHost.ts';
import type { UIContext, UIIntent, UIResult } from '../../../src/core/ui/intent.ts';

function makeCtx(overrides?: Partial<UIContext>): UIContext {
  return {
    turnId: 'turn-1',
    correlationId: 'corr-1',
    channelId: 'cli',
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('SPEC-830: NullUIHost', () => {
  test('ask() always resolves to cancel (confirm)', async () => {
    const host = new NullUIHost();
    const intent: UIIntent = { kind: 'confirm', prompt: 'Continue?' };
    const result = await host.ask(intent, makeCtx());
    expect(result.kind).toBe('cancel');
  });

  test('ask() always resolves to cancel (pick)', async () => {
    const host = new NullUIHost();
    const intent: UIIntent = {
      kind: 'pick',
      prompt: 'Choose:',
      options: [{ id: 'a', label: 'Option A' }],
    };
    const result = await host.ask(intent, makeCtx());
    expect(result.kind).toBe('cancel');
  });

  test('ask() always resolves to cancel (input)', async () => {
    const host = new NullUIHost();
    const intent: UIIntent = { kind: 'input', prompt: 'Enter:' };
    const result = await host.ask(intent, makeCtx());
    expect(result.kind).toBe('cancel');
  });

  test('ask() always resolves to cancel (status)', async () => {
    const host = new NullUIHost();
    const intent: UIIntent = { kind: 'status', message: 'Done', level: 'info' };
    const result = await host.ask(intent, makeCtx());
    expect(result.kind).toBe('cancel');
  });

  test('NullUIHost satisfies UIHost interface', () => {
    // Type-level check: NullUIHost is assignable to UIHost.
    const host: UIHost = new NullUIHost();
    expect(typeof host.ask).toBe('function');
  });

  test('NullUIHost does not throw — non-interactive channels are safe', async () => {
    const host = new NullUIHost();
    const intent: UIIntent = { kind: 'confirm', prompt: 'Destructive op?' };
    // Must resolve without throwing (callers rely on this for graceful degradation).
    await expect(host.ask(intent, makeCtx())).resolves.toEqual({ kind: 'cancel' });
  });
});

describe('SPEC-830: UIHost interface structural check', () => {
  test('custom implementation can be constructed from plain object', async () => {
    // Verify UIHost is a structural interface — no class base required.
    const mockHost: UIHost = {
      ask: async <T>(_intent: UIIntent, _ctx: UIContext): Promise<UIResult<T>> =>
        ({ kind: 'ok', value: 'yes' as unknown as T }),
    };
    const result = await mockHost.ask({ kind: 'confirm', prompt: 'ok?' }, makeCtx());
    expect(result.kind).toBe('ok');
  });
});
