// uiHost.ts — SPEC-831: TelegramUIHost implements UIHost contract (SPEC-830).
// Revives dead approval.ts code and wires Telegram inline keyboard into onAsk.
// Pending intents stored in-memory with 5-min TTL; expires resolve with 'timeout'.

import { logger } from '../../observability/logger.ts';
import type { UIHost, UIIntent, UIContext, UIResult } from '../../core/ui/index.ts';
import type { createTelegramAdapter, TelegramCallbackQuery } from './adapter.ts';
import {
  buildApprovalKeyboard,
  parseApprovalCallback,
  type ApprovalDecision,
} from './approval.ts';

/** Concrete adapter type surfaced from createTelegramAdapter return. */
type TelegramAdapter = ReturnType<typeof createTelegramAdapter>;

/** Default TTL for pending intents (5 minutes in ms). */
const PENDING_TTL_MS = 5 * 60 * 1000;
/** Default confirm timeout passed through UIIntent (60 seconds). */
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
/** Max pick options per message before truncating. */
const MAX_PICK_OPTIONS = 8;

/** Internal pending entry for confirm and pick intents. */
interface PendingEntry {
  correlationId: string;
  messageId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (r: UIResult<any>) => void;
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/** Dependencies injected into createTelegramUIHost. */
export interface TelegramUIHostDeps {
  adapter: TelegramAdapter;
  chatId: number;
  allowedUserIds: Set<number>;
  logger?: typeof logger;
}

/**
 * createTelegramUIHost — factory producing a UIHost bound to a single Telegram chat.
 *
 * id = 'telegram:chat:{chatId}'
 *
 * Supports: confirm, pick, input, status intents.
 * - confirm → inline_keyboard (Approve / Always / Deny)
 * - pick    → inline_keyboard rows (≤ MAX_PICK_OPTIONS items)
 * - input   → sendMessage with ForceReply, waits for next text message (not yet wired in v0.3)
 * - status  → sendMessage text-only
 */
export function createTelegramUIHost(deps: TelegramUIHostDeps): UIHost {
  const { adapter, chatId, allowedUserIds } = deps;
  const log = deps.logger ?? logger;

  // correlationId → pending entry
  const pending = new Map<string, PendingEntry>();

  // Subscribe to callback_query events from adapter.
  const disposeHandler = adapter.onCallbackQuery(handleCallbackQuery);

  function handleCallbackQuery(cq: TelegramCallbackQuery): void {
    // Only handle events for our chat.
    if (cq.chatId !== chatId) return;

    // Allowlist check (adapter already filters globally, but belt-and-suspenders).
    if (!allowedUserIds.has(cq.userId)) {
      log.warn({ userId: cq.userId, chatId }, 'uiHost: callback from non-allowed user, dropping');
      return;
    }

    // Try approval callback first.
    const approval = parseApprovalCallback(cq.data);
    if (approval) {
      const entry = pending.get(approval.requestId);
      if (!entry) {
        log.warn({ requestId: approval.requestId }, 'uiHost: stale approval correlation id, dropping');
        return;
      }
      const msgId = entry.messageId;
      resolvePending(approval.requestId, approval.decision);
      adapter.editMessageReplyMarkup(chatId, msgId, null).catch((err) => {
        log.warn({ err: (err as Error).message }, 'uiHost: editMessageReplyMarkup failed');
      });
      return;
    }

    // Try pick callback.
    const pick = parsePickCallback(cq.data);
    if (pick) {
      const entry = pending.get(pick.correlationId);
      if (!entry) {
        log.warn({ correlationId: pick.correlationId }, 'uiHost: stale pick correlation id, dropping');
        return;
      }
      const msgId = entry.messageId;
      // Resolve with the selected option id.
      clearTimeout(entry.timeoutHandle);
      pending.delete(pick.correlationId);
      entry.resolve({ kind: 'ok', value: pick.optionId });
      adapter.editMessageReplyMarkup(chatId, msgId, null).catch((err) => {
        log.warn({ err: (err as Error).message }, 'uiHost: editMessageReplyMarkup (pick) failed');
      });
      return;
    }

    log.warn({ data: cq.data, chatId }, 'uiHost: unparseable callback_data, dropping');
  }

  function parsePickCallback(data: string): { correlationId: string; optionId: string } | null {
    const prefix = 'pick:';
    if (!data.startsWith(prefix)) return null;
    const rest = data.slice(prefix.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    return { correlationId: rest.slice(0, colonIdx), optionId: rest.slice(colonIdx + 1) };
  }

  function resolvePending(correlationId: string, decision: ApprovalDecision | 'timeout' | 'cancel'): void {
    const entry = pending.get(correlationId);
    if (!entry) return;

    clearTimeout(entry.timeoutHandle);
    pending.delete(correlationId);

    if (decision === 'timeout') {
      entry.resolve({ kind: 'timeout' });
    } else if (decision === 'cancel') {
      entry.resolve({ kind: 'cancel' });
    } else {
      entry.resolve({ kind: 'ok', value: decision });
    }
  }

  function scheduleExpiry(correlationId: string, ttlMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      log.warn({ correlationId, chatId }, 'uiHost: intent timed out');
      const entry = pending.get(correlationId);
      if (entry) {
        // Edit message to show "Timed out" text.
        adapter.editMessageReplyMarkup(chatId, entry.messageId, null).catch(() => undefined);
        resolvePending(correlationId, 'timeout');
      }
    }, ttlMs);
  }

  async function askConfirm(
    intent: UIIntent & { kind: 'confirm' },
    ctx: UIContext,
  ): Promise<UIResult<ApprovalDecision>> {
    const { correlationId, abortSignal } = ctx;
    const timeoutMs = intent.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const effectiveTtl = Math.min(timeoutMs, PENDING_TTL_MS);

    return new Promise<UIResult<ApprovalDecision>>((resolve) => {
      // Register pending entry BEFORE sending the message so that a callback
      // fired synchronously during the send does not miss the map entry.
      // messageId is unknown yet; default to 0. Updated after send resolves.
      const timeoutHandle = scheduleExpiry(correlationId, effectiveTtl);
      const entry: PendingEntry = {
        correlationId,
        messageId: 0,
        resolve: resolve as (r: UIResult<unknown>) => void,
        expiresAt: Date.now() + effectiveTtl,
        timeoutHandle,
      };
      pending.set(correlationId, entry);

      // Abort signal cancels pending.
      if (abortSignal.aborted) {
        resolvePending(correlationId, 'cancel');
        return;
      }
      abortSignal.addEventListener('abort', () => {
        if (pending.has(correlationId)) {
          resolvePending(correlationId, 'cancel');
          adapter.editMessageReplyMarkup(chatId, entry.messageId, null).catch(() => undefined);
          sendCancelledEdit(entry.messageId, intent.prompt).catch(() => undefined);
        }
      }, { once: true });

      // Now send the message; update messageId when done.
      const keyboard = buildApprovalKeyboard(correlationId, { includeAlways: true });
      sendMessage(intent.prompt, keyboard as unknown as Record<string, unknown>).then((msgId) => {
        entry.messageId = msgId;
      }).catch((err) => {
        log.warn({ err: (err as Error).message }, 'uiHost: sendMessage failed for confirm');
        resolvePending(correlationId, 'cancel');
      });
    });
  }

  function askPick(
    intent: UIIntent & { kind: 'pick' },
    ctx: UIContext,
  ): Promise<UIResult<string>> {
    const { correlationId, abortSignal } = ctx;
    const options = intent.options.slice(0, MAX_PICK_OPTIONS);

    const rows = options.map((opt) => [{
      text: opt.label + (opt.hint ? ` — ${opt.hint}` : ''),
      callback_data: buildPickCallbackData(correlationId, opt.id),
    }]);
    const keyboard = { inline_keyboard: rows };

    return new Promise<UIResult<string>>((resolve) => {
      const timeoutHandle = scheduleExpiry(correlationId, PENDING_TTL_MS);
      const entry: PendingEntry = {
        correlationId,
        messageId: 0,
        resolve: resolve as (r: UIResult<unknown>) => void,
        expiresAt: Date.now() + PENDING_TTL_MS,
        timeoutHandle,
      };
      pending.set(correlationId, entry);

      if (abortSignal.aborted) {
        resolvePending(correlationId, 'cancel');
        return;
      }
      abortSignal.addEventListener('abort', () => {
        if (pending.has(correlationId)) {
          resolvePending(correlationId, 'cancel');
          adapter.editMessageReplyMarkup(chatId, entry.messageId, null).catch(() => undefined);
        }
      }, { once: true });

      sendMessage(intent.prompt, keyboard).then((msgId) => {
        entry.messageId = msgId;
      }).catch((err) => {
        log.warn({ err: (err as Error).message }, 'uiHost: sendMessage failed for pick');
        resolvePending(correlationId, 'cancel');
      });
    });
  }

  async function askStatus(
    intent: UIIntent & { kind: 'status' },
  ): Promise<UIResult<void>> {
    const prefix = intent.level === 'error' ? '❌' : intent.level === 'warn' ? '⚠️' : 'ℹ️';
    await sendMessage(`${prefix} ${intent.message}`);
    return { kind: 'ok', value: undefined };
  }

  async function askInput(
    intent: UIIntent & { kind: 'input' },
  ): Promise<UIResult<string>> {
    // For v0.3: send a ForceReply prompt and immediately return cancel.
    // Full wiring (waiting for next message) is deferred to v0.4 SPEC-832.
    const body = intent.secret ? `${intent.prompt}\n(reply with your value)` : intent.prompt;
    await sendMessage(body, { reply_markup: { force_reply: true, selective: true } });
    return { kind: 'cancel' };
  }

  async function sendMessage(
    text: string,
    replyMarkup?: Record<string, unknown> | null,
  ): Promise<number> {
    return adapter.sendToChatWithId(chatId, text, replyMarkup ?? undefined);
  }

  async function sendCancelledEdit(messageId: number, originalPrompt: string): Promise<void> {
    // Strip buttons; full message-text edit deferred to SPEC-832.
    void originalPrompt;
    await adapter.editMessageReplyMarkup(chatId, messageId, null);
  }

  function buildPickCallbackData(correlationId: string, optionId: string): string {
    const prefix = 'pick:';
    const maxLen = 64 - prefix.length;
    const combined = `${correlationId}:${optionId}`;
    return prefix + combined.slice(0, maxLen);
  }

  return {
    id: `telegram:chat:${chatId}`,
    supports: ['confirm', 'pick', 'input', 'status'] as const,
    canAsk(): boolean {
      return true; // adapter is always connected when UIHost is created
    },

    async ask<T>(intent: UIIntent, ctx: UIContext): Promise<UIResult<T>> {
      switch (intent.kind) {
        case 'confirm':
          return askConfirm(intent, ctx) as Promise<UIResult<T>>;
        case 'pick':
          return askPick(intent, ctx) as Promise<UIResult<T>>;
        case 'status':
          return askStatus(intent) as Promise<UIResult<T>>;
        case 'input':
          return askInput(intent) as Promise<UIResult<T>>;
        default:
          return { kind: 'cancel' };
      }
    },

    /** Dispose the callback_query subscription — call when the UIHost is no longer needed. */
    dispose(): void {
      disposeHandler();
      // Reject all pending intents.
      for (const correlationId of pending.keys()) {
        resolvePending(correlationId, 'cancel');
      }
    },
  } as UIHost & { id: string; supports: readonly string[]; canAsk(): boolean; dispose(): void };
}
