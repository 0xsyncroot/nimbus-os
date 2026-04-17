// uiHost.test.ts — SPEC-831: TelegramUIHost unit tests.
// Tests: UIHost contract, confirm/pick intent dispatch, callback_query resolution,
// button-strip idempotency, timeout, abort signal.

import { describe, expect, test, mock } from 'bun:test';
import { createTelegramUIHost } from '../../../src/channels/telegram/uiHost.ts';
import {
  buildApprovalKeyboard,
  parseApprovalCallback,
} from '../../../src/channels/telegram/approval.ts';
import type { TelegramCallbackQuery } from '../../../src/channels/telegram/adapter.ts';

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

interface MockAdapterCalls {
  sendToChatWithId: Array<{ chatId: number; text: string; markup?: unknown }>;
  editMessageReplyMarkup: Array<{ chatId: number; messageId: number }>;
}

function createMockAdapter(chatId: number, messageIdCounter = 100) {
  const calls: MockAdapterCalls = { sendToChatWithId: [], editMessageReplyMarkup: [] };
  let cbHandler: ((cq: TelegramCallbackQuery) => void) | null = null;
  let nextMsgId = messageIdCounter;

  const adapter = {
    sendToChat: mock(async () => {}),
    sendToChatWithId: mock(async (_cid: number, text: string, markup?: unknown) => {
      calls.sendToChatWithId.push({ chatId: _cid, text, markup });
      return nextMsgId++;
    }),
    editMessageReplyMarkup: mock(async (_cid: number, msgId: number) => {
      calls.editMessageReplyMarkup.push({ chatId: _cid, messageId: msgId });
    }),
    onCallbackQuery: mock((handler: (cq: TelegramCallbackQuery) => void) => {
      cbHandler = handler;
      return () => { cbHandler = null; };
    }),
  };

  function fireCallback(cq: TelegramCallbackQuery): void {
    cbHandler?.(cq);
  }

  return { adapter, calls, fireCallback };
}

function makeAbort(aborted = false): AbortSignal {
  const ctrl = new AbortController();
  if (aborted) ctrl.abort();
  return ctrl.signal;
}

// ---------------------------------------------------------------------------
// SPEC-831 T1: UIHost skeleton
// ---------------------------------------------------------------------------

describe('SPEC-831 T1: createTelegramUIHost — skeleton', () => {
  const CHAT_ID = 42;
  const ALLOWED = new Set([999]);

  test('returns object with correct id', () => {
    const { adapter } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });
    // Cast to access extended properties.
    const ext = host as unknown as { id: string; supports: readonly string[]; canAsk(): boolean };
    expect(ext.id).toBe(`telegram:chat:${CHAT_ID}`);
  });

  test('supports includes confirm, pick, input, status', () => {
    const { adapter } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });
    const ext = host as unknown as { supports: readonly string[] };
    expect(ext.supports).toContain('confirm');
    expect(ext.supports).toContain('pick');
    expect(ext.supports).toContain('input');
    expect(ext.supports).toContain('status');
  });

  test('canAsk() returns true', () => {
    const { adapter } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });
    const ext = host as unknown as { canAsk(): boolean };
    expect(ext.canAsk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SPEC-831 T2: confirm intent — inline keyboard + callback resolution
// ---------------------------------------------------------------------------

describe('SPEC-831 T2: host.ask confirm', () => {
  const CHAT_ID = 42;
  const USER_ID = 999;
  const ALLOWED = new Set([USER_ID]);
  const CORRELATION = 'corr-001';

  test('sendToChatWithId called with 3-button inline_keyboard for confirm intent', async () => {
    const { adapter, calls, fireCallback } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });

    const askPromise = host.ask<string>(
      { kind: 'confirm', prompt: 'Allow rm?', timeoutMs: 5000 },
      { turnId: 'turn-1', correlationId: CORRELATION, channelId: 'telegram', abortSignal: makeAbort() },
    );

    // Give microtask a tick to let sendToChatWithId fire.
    await Promise.resolve();

    expect(calls.sendToChatWithId.length).toBe(1);
    const markup = calls.sendToChatWithId[0]!.markup as { inline_keyboard: { text: string }[][] };
    expect(markup.inline_keyboard[0]).toHaveLength(3);
    const texts = markup.inline_keyboard[0]!.map((b) => b.text);
    expect(texts.some((t) => t.includes('Approve'))).toBe(true);
    expect(texts.some((t) => t.includes('Always'))).toBe(true);
    expect(texts.some((t) => t.includes('Deny'))).toBe(true);

    // Resolve the promise by simulating a callback.
    const kb = buildApprovalKeyboard(CORRELATION, { includeAlways: true });
    const approveBtn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Approve'))!;
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: approveBtn.callback_data, messageId: 100, queryId: 'q1' });

    const result = await askPromise;
    expect(result.kind).toBe('ok');
    // @ts-expect-error — value is typed as T but we know it's string
    expect(result.value).toBe('allow');
  });

  test('callback with allow decision resolves promise with {kind:ok, value:allow}', async () => {
    const { adapter, fireCallback } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });

    const askPromise = host.ask<string>(
      { kind: 'confirm', prompt: 'Allow?', timeoutMs: 5000 },
      { turnId: 't1', correlationId: CORRELATION, channelId: 'telegram', abortSignal: makeAbort() },
    );
    await Promise.resolve();

    const kb = buildApprovalKeyboard(CORRELATION, { includeAlways: true });
    const btn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Approve'))!;
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: btn.callback_data, messageId: 100, queryId: 'q1' });

    const result = await askPromise;
    expect(result).toEqual({ kind: 'ok', value: 'allow' });
  });

  test('editMessageReplyMarkup called after callback to strip buttons', async () => {
    const { adapter, calls, fireCallback } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });

    const askPromise = host.ask<string>(
      { kind: 'confirm', prompt: 'Allow?', timeoutMs: 5000 },
      { turnId: 't1', correlationId: CORRELATION, channelId: 'telegram', abortSignal: makeAbort() },
    );
    await Promise.resolve();

    const kb = buildApprovalKeyboard(CORRELATION, { includeAlways: false });
    const btn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Approve'))!;
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: btn.callback_data, messageId: 100, queryId: 'q1' });

    await askPromise;
    // Allow microtask for editMessageReplyMarkup (called via promise).
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.editMessageReplyMarkup.length).toBeGreaterThanOrEqual(1);
  });

  test('second tap after resolution is a no-op (stale correlation)', async () => {
    const { adapter, calls, fireCallback } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });

    const askPromise = host.ask<string>(
      { kind: 'confirm', prompt: 'Allow?', timeoutMs: 5000 },
      { turnId: 't1', correlationId: CORRELATION, channelId: 'telegram', abortSignal: makeAbort() },
    );
    await Promise.resolve();

    const kb = buildApprovalKeyboard(CORRELATION, { includeAlways: true });
    const btn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Approve'))!;

    // First tap — resolves.
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: btn.callback_data, messageId: 100, queryId: 'q1' });
    await askPromise;

    const editCountAfterFirst = calls.editMessageReplyMarkup.length;

    // Second tap — should be silently dropped (no extra resolve, no extra edit).
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: btn.callback_data, messageId: 100, queryId: 'q2' });
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.editMessageReplyMarkup.length).toBe(editCountAfterFirst);
  });

  test('non-allowed user tap is dropped', async () => {
    const { adapter, calls, fireCallback } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: ALLOWED });

    const askPromise = host.ask<string>(
      { kind: 'confirm', prompt: 'Allow?', timeoutMs: 5000 },
      { turnId: 't1', correlationId: CORRELATION, channelId: 'telegram', abortSignal: makeAbort() },
    );
    await Promise.resolve();

    // Non-allowed user.
    const kb = buildApprovalKeyboard(CORRELATION);
    const btn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Approve'))!;
    fireCallback({ chatId: CHAT_ID, userId: 12345, data: btn.callback_data, messageId: 100, queryId: 'q1' });

    // Verify the promise is still pending (not resolved).
    let settled = false;
    askPromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(calls.editMessageReplyMarkup.length).toBe(0);

    // Clean up by resolving with deny.
    const denyBtn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Deny'))!;
    fireCallback({ chatId: CHAT_ID, userId: USER_ID, data: denyBtn.callback_data, messageId: 100, queryId: 'q2' });
    await askPromise;
  });
});

// ---------------------------------------------------------------------------
// SPEC-831 T3: timeout path
// ---------------------------------------------------------------------------

describe('SPEC-831 T3: timeout', () => {
  test('intent times out after timeoutMs → {kind:timeout}', async () => {
    const CHAT_ID = 55;
    const { adapter } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: new Set([1]) });

    const result = await host.ask<string>(
      { kind: 'confirm', prompt: 'Test timeout', timeoutMs: 30 },
      { turnId: 't-timeout', correlationId: 'corr-timeout', channelId: 'telegram', abortSignal: makeAbort() },
    );
    expect(result.kind).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// SPEC-831 T4: abort signal
// ---------------------------------------------------------------------------

describe('SPEC-831 T4: abort signal', () => {
  test('pre-aborted signal returns {kind:cancel} immediately', async () => {
    const CHAT_ID = 66;
    const { adapter } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: new Set([1]) });

    const result = await host.ask<string>(
      { kind: 'confirm', prompt: 'Cancel me', timeoutMs: 5000 },
      { turnId: 't-abort', correlationId: 'corr-abort', channelId: 'telegram', abortSignal: makeAbort(true) },
    );
    expect(result.kind).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// SPEC-831 T5: status intent
// ---------------------------------------------------------------------------

describe('SPEC-831 T5: status intent', () => {
  test('status intent sends message and returns {kind:ok}', async () => {
    const CHAT_ID = 77;
    const { adapter, calls } = createMockAdapter(CHAT_ID);
    const host = createTelegramUIHost({ adapter: adapter as never, chatId: CHAT_ID, allowedUserIds: new Set([1]) });

    const result = await host.ask<void>(
      { kind: 'status', message: 'Processing...', level: 'info' },
      { turnId: 't-status', correlationId: 'corr-status', channelId: 'telegram', abortSignal: makeAbort() },
    );
    expect(result.kind).toBe('ok');
    expect(calls.sendToChatWithId.length).toBe(1);
    expect(calls.sendToChatWithId[0]!.text).toContain('Processing...');
  });
});

// ---------------------------------------------------------------------------
// SPEC-831 T6: approval.ts backward-compat — 2-button default
// ---------------------------------------------------------------------------

describe('SPEC-831 T6: buildApprovalKeyboard backward compat', () => {
  test('default (no opts) returns 2 buttons', () => {
    const kb = buildApprovalKeyboard('req-123');
    expect(kb.inline_keyboard[0]).toHaveLength(2);
  });

  test('includeAlways: true returns 3 buttons', () => {
    const kb = buildApprovalKeyboard('req-123', { includeAlways: true });
    expect(kb.inline_keyboard[0]).toHaveLength(3);
  });

  test('parseApprovalCallback handles always decision', () => {
    const kb = buildApprovalKeyboard('req-abc', { includeAlways: true });
    const alwaysBtn = kb.inline_keyboard[0]!.find((b) => b.text.includes('Always'))!;
    const result = parseApprovalCallback(alwaysBtn.callback_data);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('always');
  });
});
