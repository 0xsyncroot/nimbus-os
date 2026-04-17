// adapter.ts — SPEC-803 T3+T4 / SPEC-831: Telegram channel adapter (long-polling via Telegram Bot API).
// Uses fetch + Telegram Bot API directly (no grammy dependency required at runtime).
// Unknown userIds silently dropped + security event published. Rate-limited outbound.
// SPEC-831: callback_query events routed to registered handlers (TelegramUIHost).

import { logger } from '../../observability/logger.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { getGlobalBus } from '../../core/events.ts';
import { TOPICS } from '../../core/eventTypes.ts';
import type { ChannelAdapter, NativeFormat } from '../ChannelAdapter.ts';
import { createRateLimiter } from '../common/rateLimiter.ts';
import { telegramMsgToEvent, textToTelegramHtml, type TelegramMessage } from './serde.ts';
import type { ApprovalKeyboard } from './approval.ts';
import { getBest } from '../../platform/secrets/index.ts';

export interface TelegramAdapterConfig {
  /** Telegram Bot API token — loaded from vault under `telegram.botToken`. */
  readonly botToken?: string; // optional: if absent, read from vault at start()
  /** Telegram user IDs allowed to reach the agent. */
  readonly allowedUserIds: number[];
  /** Map telegramUserId → nimbus workspaceId. */
  readonly workspaceMapping: Record<number, string>;
  /** Default workspace when userId has no explicit mapping. */
  readonly defaultWorkspaceId?: string;
  /** Enable webhook mode (future v0.3.1). Currently ignored. */
  readonly webhookMode?: false;
}

/** Minimum interval between Telegram long-poll requests (milliseconds). */
const POLL_INTERVAL_MS = 1000;
/** Telegram long-poll timeout (seconds). */
const LONG_POLL_TIMEOUT_SEC = 30;
/** Telegram Bot API base URL. */
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
/** Valid Telegram userId pattern: positive integer. */
const VALID_USER_ID_RE = /^\d+$/;

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: TelegramMessage;
  };
}

interface ApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/** Shape of a parsed callback_query event emitted by the adapter. */
export interface TelegramCallbackQuery {
  chatId: number;
  userId: number;
  data: string;
  messageId: number;
  queryId: string;
}

/** Handler registered by TelegramUIHost to receive callback_query events. */
export type CallbackQueryHandler = (cq: TelegramCallbackQuery) => void;

export function createTelegramAdapter(cfg: TelegramAdapterConfig): ChannelAdapter & {
  /** Send a message to a specific Telegram chat (used by agent reply handler). */
  sendToChat(chatId: number, text: string, replyMarkup?: ApprovalKeyboard): Promise<void>;
  /** SPEC-831: Send message and return the assigned messageId. */
  sendToChatWithId(chatId: number, text: string, replyMarkup?: ApprovalKeyboard | Record<string, unknown>): Promise<number>;
  /** SPEC-831: Edit (remove) the reply markup of an already-sent message. */
  editMessageReplyMarkup(chatId: number, messageId: number, markup: ApprovalKeyboard | null): Promise<void>;
  /** SPEC-831: Register a callback_query handler; returns a dispose function. */
  onCallbackQuery(handler: CallbackQueryHandler): () => void;
} {
  let token: string | null = cfg.botToken ?? null;
  let running = false;
  let offset = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // SPEC-831: callback_query handler registry.
  const callbackQueryHandlers = new Set<CallbackQueryHandler>();

  // Telegram limits: 30 msg/sec global + 1 msg/sec per chat.
  const globalLimiter = createRateLimiter({ capacity: 30, refillRatePerSec: 30 });
  const chatLimiters = new Map<number, ReturnType<typeof createRateLimiter>>();

  function getChatLimiter(chatId: number) {
    let lim = chatLimiters.get(chatId);
    if (!lim) {
      lim = createRateLimiter({ capacity: 1, refillRatePerSec: 1 });
      chatLimiters.set(chatId, lim);
    }
    return lim;
  }

  async function apiCall<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API_BASE}${token}/${method}`;
    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      throw new NimbusError(ErrorCode.P_NETWORK, {
        reason: 'telegram_api_http_error',
        status: resp.status,
        method,
      });
    }
    const json = (await resp.json()) as ApiResponse<T>;
    if (!json.ok) {
      throw new NimbusError(ErrorCode.P_NETWORK, {
        reason: 'telegram_api_error',
        method,
        description: json.description,
      });
    }
    return json.result;
  }

  function resolveWorkspace(userId: number): string | null {
    const mapped = cfg.workspaceMapping[userId];
    if (mapped) return mapped;
    return cfg.defaultWorkspaceId ?? null;
  }

  function handleUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg?.from) return;

    const userId = msg.from.id;

    // Validate userId is a positive integer.
    if (!VALID_USER_ID_RE.test(String(userId)) || userId <= 0) {
      logger.warn({ userId }, 'telegram: invalid userId shape, dropping');
      return;
    }

    if (!cfg.allowedUserIds.includes(userId)) {
      // Security: silent drop + publish security event (no reply to unknown users).
      logger.warn({ adapterId: 'telegram', userId }, 'telegram: unauthorized user dropped');
      getGlobalBus().publish(TOPICS.security.event, {
        type: 'security.event',
        adapterId: 'telegram',
        reason: 'unauthorized_telegram_user',
        userId,
        ts: Date.now(),
      });
      return;
    }

    const workspaceId = resolveWorkspace(userId);
    if (!workspaceId) {
      logger.warn({ userId }, 'telegram: no workspace mapping, dropping');
      return;
    }

    const event = telegramMsgToEvent(msg, workspaceId);
    getGlobalBus().publish(TOPICS.channel.inbound, event);
  }

  function handleCallbackQuery(update: TelegramUpdate): void {
    const cq = update.callback_query;
    if (!cq || !cq.data || !cq.message) return;

    const userId = cq.from.id;
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;

    // Security: only process callbacks from allowed users.
    if (!cfg.allowedUserIds.includes(userId)) {
      logger.warn({ userId, chatId }, 'telegram: unauthorized callback_query dropped');
      getGlobalBus().publish(TOPICS.security.event, {
        type: 'security.event',
        adapterId: 'telegram',
        reason: 'unauthorized_telegram_callback',
        userId,
        ts: Date.now(),
      });
      return;
    }

    const payload: TelegramCallbackQuery = {
      chatId,
      userId,
      data: cq.data,
      messageId,
      queryId: cq.id,
    };

    // Dispatch to all registered handlers (TelegramUIHost instances).
    for (const handler of callbackQueryHandlers) {
      try {
        handler(payload);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'telegram: callback_query handler threw');
      }
    }
  }

  async function pollOnce(): Promise<void> {
    try {
      const updates = await apiCall<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: LONG_POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const upd of updates) {
        if (upd.callback_query) {
          handleCallbackQuery(upd);
        } else {
          handleUpdate(upd);
        }
        offset = upd.update_id + 1;
      }
    } catch (err) {
      logger.warn({ err }, 'telegram: poll error, will retry');
    }
  }

  function scheduleNextPoll(): void {
    if (!running) return;
    pollTimer = setTimeout(async () => {
      if (!running) return;
      await pollOnce();
      scheduleNextPoll();
    }, POLL_INTERVAL_MS);
  }

  async function sendToChatWithId(
    chatId: number,
    text: string,
    replyMarkup?: ApprovalKeyboard | Record<string, unknown>,
  ): Promise<number> {
    if (!token) throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'no_telegram_token' });

    // Respect rate limits.
    const globalWait = globalLimiter.consume(1);
    const chatWait = getChatLimiter(chatId).consume(1);
    const waitMs = Math.max(globalWait, chatWait);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) {
      body['reply_markup'] = replyMarkup;
    }

    const msg = await apiCall<{ message_id: number }>('sendMessage', body);
    return msg.message_id;
  }

  async function sendToChat(
    chatId: number,
    text: string,
    replyMarkup?: ApprovalKeyboard,
  ): Promise<void> {
    await sendToChatWithId(chatId, text, replyMarkup);
  }

  return {
    id: 'telegram',
    kind: 'telegram' as const,
    nativeFormat: 'telegram-html' as NativeFormat,
    capabilities: { nativeFormat: 'telegram-html' as NativeFormat },

    async start(): Promise<void> {
      if (!token) {
        const store = await getBest();
        token = await store.get('nimbus', 'telegram.botToken');
      }
      if (!token) {
        throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
          reason: 'telegram_bot_token_missing',
          hint: 'Run: nimbus key set --service=telegram.botToken <token>',
        });
      }
      running = true;
      logger.info('telegram: adapter started (long-polling)');
      scheduleNextPoll();
    },

    async stop(): Promise<void> {
      running = false;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      // Drain chat limiters — allow in-flight sends to complete (best-effort 2s).
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      logger.info('telegram: adapter stopped');
    },

    async send(workspaceId: string, text: string): Promise<void> {
      // Find a chat ID for this workspaceId (reverse lookup from workspaceMapping).
      const entry = Object.entries(cfg.workspaceMapping).find(([, ws]) => ws === workspaceId);
      if (!entry) {
        logger.warn({ workspaceId }, 'telegram: no chatId for workspaceId, cannot send');
        return;
      }
      const chatId = Number(entry[0]);
      await sendToChat(chatId, textToTelegramHtml(text));
    },

    sendToChat,
    sendToChatWithId,

    async editMessageReplyMarkup(
      chatId: number,
      messageId: number,
      markup: ApprovalKeyboard | null,
    ): Promise<void> {
      if (!token) throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'no_telegram_token' });
      const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
      if (markup) {
        body['reply_markup'] = markup;
      } else {
        // Pass empty inline_keyboard to strip buttons.
        body['reply_markup'] = { inline_keyboard: [] };
      }
      await apiCall('editMessageReplyMarkup', body);
    },

    onCallbackQuery(handler: CallbackQueryHandler): () => void {
      callbackQueryHandlers.add(handler);
      return () => { callbackQueryHandlers.delete(handler); };
    },
  };
}

