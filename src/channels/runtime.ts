// runtime.ts — SPEC-808: singleton ChannelRuntime + inbound → runTurn bridge.
// One per REPL process. Holds the ChannelManager, the Telegram adapter handle,
// and the inbound-event subscription that feeds messages into the real agent loop.

import { logger } from '../observability/logger.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { getGlobalBus, type Disposable } from '../core/events.ts';
import { TOPICS } from '../core/eventTypes.ts';
import type { ChannelInboundEvent } from '../core/eventTypes.ts';
import type { Provider } from '../ir/types.ts';
import { createChannelManager, type ChannelManager } from './ChannelManager.ts';
import { createTelegramAdapter, type TelegramAdapterConfig } from './telegram/adapter.ts';
import {
  getAllowedUserIds,
  getTelegramBotToken,
  setDefaultWorkspaceId,
} from './telegram/config.ts';
import { runTurn } from '../core/loop.ts';
import { createTurnAbort } from '../core/cancellation.ts';
import { getOrCreateSession, appendToCache, getCachedMessages } from '../core/sessionManager.ts';
import { createLoopAdapter, type ToolRegistry } from '../tools/index.ts';
import type { Gate } from '../permissions/index.ts';
import type { TurnContext } from '../core/turn.ts';

interface TelegramHandle {
  adapter: ReturnType<typeof createTelegramAdapter>;
  botUsername: string;
}

export interface StartTelegramOptions {
  wsId: string;
  provider: Provider;
  model: string;
  registry: ToolRegistry;
  gate: Gate;
  cwd: string;
}

export interface ChannelRuntime {
  manager: ChannelManager;
  startTelegram(opts: StartTelegramOptions): Promise<{ botUsername: string }>;
  stopTelegram(): Promise<void>;
  isTelegramRunning(): boolean;
  getTelegramBotUsername(): string | null;
  dispose(): Promise<void>;
}

/** Extract the raw user text from the META-009 trust wrapper while preserving
 *  the "untrusted" framing in the prompt-visible form. For Telegram inbound we
 *  keep the wrapper so the agent treats it as untrusted input (defense-in-depth
 *  vs prompt-injection over the channel), but decode HTML entities back to
 *  their raw form so legitimate quotes / code render correctly. */
function prepareInboundText(text: string): string {
  const m = text.match(/^<tool_output trusted="false">([\s\S]*)<\/tool_output>$/);
  if (!m) return text;
  const inner = decodeHtmlEntities(m[1] ?? '');
  // Preserve the trust framing so the agent knows this came via a channel.
  return `<channel_input source="telegram" trusted="false">${escapeForTag(inner)}</channel_input>`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeForTag(text: string): string {
  // Prevent the closing tag from being spoofed by user content.
  return text.replace(/<\/channel_input>/gi, '&lt;/channel_input&gt;');
}

/** Fetch `@username` via getMe — token validated by this round-trip. */
async function fetchBotUsername(token: string): Promise<string> {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new NimbusError(ErrorCode.P_AUTH, {
      reason: 'telegram_getme_http_error',
      status: resp.status,
      hint: 'check token via @BotFather',
    });
  }
  const body = (await resp.json()) as {
    ok: boolean;
    result?: { username?: string; first_name?: string };
    description?: string;
  };
  if (!body.ok || !body.result) {
    throw new NimbusError(ErrorCode.P_AUTH, {
      reason: 'telegram_getme_failed',
      description: body.description,
    });
  }
  const username = body.result.username ?? body.result.first_name ?? 'bot';
  return username;
}

function createRuntime(): ChannelRuntime {
  const bus = getGlobalBus();
  const manager = createChannelManager(bus);
  let telegram: TelegramHandle | null = null;
  let inboundSub: Disposable | null = null;
  // Per-chat serial queue to avoid interleaved turns for the same user.
  const chatQueues = new Map<string, Promise<void>>();

  function enqueueChat(
    chatKey: string,
    task: () => Promise<void>,
  ): void {
    const prev = chatQueues.get(chatKey) ?? Promise.resolve();
    const next = prev.then(task, task).catch((err) => {
      logger.warn(
        { err: (err as Error).message, chatKey },
        'channel runtime: inbound task failed',
      );
    });
    chatQueues.set(
      chatKey,
      next.finally(() => {
        if (chatQueues.get(chatKey) === next) chatQueues.delete(chatKey);
      }),
    );
  }

  async function handleInbound(
    event: ChannelInboundEvent,
    ctx: StartTelegramOptions,
  ): Promise<void> {
    if (event.adapterId !== 'telegram' || !telegram) return;
    const userText = prepareInboundText(event.text);
    if (!userText.trim()) return;

    // Extract chatId from the raw Telegram message for the reply path.
    const raw = event.raw as { chat?: { id?: number }; from?: { id?: number } } | null;
    const chatId = raw?.chat?.id ?? raw?.from?.id;
    if (typeof chatId !== 'number') {
      logger.warn({ adapterId: event.adapterId }, 'channel runtime: no chatId in inbound event');
      return;
    }

    const session = await getOrCreateSession(ctx.wsId);
    const abort = createTurnAbort();
    const priorMessages = getCachedMessages(session.id);
    const turnCtx: TurnContext = {
      sessionId: session.id,
      wsId: ctx.wsId,
      channel: 'telegram',
      mode: 'default',
      abort,
      provider: ctx.provider,
      model: ctx.model,
    };

    const toolAdapter = createLoopAdapter({
      registry: ctx.registry,
      permissions: ctx.gate,
      workspaceId: ctx.wsId,
      sessionId: session.id,
      cwd: ctx.cwd,
      mode: 'default',
      // No onAsk for Telegram channel — approvals surface via inline keyboard
      // in a future iteration. For now, destructive ops will return
      // needs_confirm and the agent will report that back via reply.
    });

    const userMsg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: userText }],
    };
    appendToCache(session.id, userMsg);

    let assistantTextBuf = '';
    let assistantFinalText = '';
    try {
      for await (const out of runTurn({
        ctx: turnCtx,
        userMessage: userText,
        tools: toolAdapter,
        priorMessages,
      })) {
        if (out.kind === 'chunk' && out.chunk.type === 'content_block_delta' && out.chunk.delta.type === 'text') {
          assistantTextBuf += out.chunk.delta.text ?? '';
        } else if (out.kind === 'chunk' && out.chunk.type === 'content_block_stop') {
          if (assistantTextBuf.length > 0) {
            appendToCache(session.id, {
              role: 'assistant',
              content: [{ type: 'text', text: assistantTextBuf }],
            });
            assistantFinalText += assistantTextBuf;
            assistantTextBuf = '';
          }
        }
      }
      if (assistantTextBuf.length > 0) {
        appendToCache(session.id, {
          role: 'assistant',
          content: [{ type: 'text', text: assistantTextBuf }],
        });
        assistantFinalText += assistantTextBuf;
      }
    } catch (err) {
      const message = err instanceof NimbusError ? err.code : (err as Error).message;
      logger.error({ err: message, wsId: ctx.wsId }, 'channel runtime: turn failed');
      assistantFinalText = 'Em gặp lỗi khi xử lý tin nhắn — anh thử lại sau nhé.';
    }

    const reply = assistantFinalText.trim().length > 0
      ? assistantFinalText.trim()
      : 'Em đã nhận được tin — nhưng chưa có phản hồi nội dung.';

    try {
      await telegram.adapter.sendToChat(chatId, reply);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, chatId },
        'channel runtime: reply send failed',
      );
    }
  }

  return {
    manager,

    async startTelegram(opts: StartTelegramOptions): Promise<{ botUsername: string }> {
      if (telegram) return { botUsername: telegram.botUsername };

      const token = await getTelegramBotToken(opts.wsId);
      if (!token) {
        throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
          reason: 'telegram_bot_token_missing',
          hint: 'run `nimbus telegram set-token` to set your bot token from @BotFather',
        });
      }
      const allowed = await getAllowedUserIds(opts.wsId);
      if (allowed.length === 0) {
        throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
          reason: 'telegram_allowlist_empty',
          hint: 'run `nimbus telegram allow <your-telegram-user-id>` to authorise at least one user',
        });
      }

      const botUsername = await fetchBotUsername(token);

      // Ensure default workspace is set so unknown-chat mapping falls through.
      await setDefaultWorkspaceId(opts.wsId, opts.wsId).catch(() => undefined);

      const workspaceMapping: Record<number, string> = {};
      for (const uid of allowed) workspaceMapping[uid] = opts.wsId;

      const cfg: TelegramAdapterConfig = {
        botToken: token,
        allowedUserIds: allowed,
        workspaceMapping,
        defaultWorkspaceId: opts.wsId,
      };
      const adapter = createTelegramAdapter(cfg);

      manager.register(adapter);
      // Subscribe BEFORE start — inbound events can arrive immediately.
      inboundSub = bus.subscribe<ChannelInboundEvent>(
        TOPICS.channel.inbound,
        (event) => {
          const chatKey = String(
            (event.raw as { chat?: { id?: number } } | null)?.chat?.id ?? event.userId,
          );
          enqueueChat(chatKey, () => handleInbound(event, opts));
        },
      );
      await manager.startAll();

      telegram = { adapter, botUsername };
      logger.info(
        { botUsername, adapterId: 'telegram', allowedCount: allowed.length },
        'channel runtime: telegram started',
      );
      return { botUsername };
    },

    async stopTelegram(): Promise<void> {
      if (!telegram) return;
      await manager.stopAll().catch(() => undefined);
      if (inboundSub) {
        inboundSub();
        inboundSub = null;
      }
      telegram = null;
      logger.info('channel runtime: telegram stopped');
    },

    isTelegramRunning(): boolean {
      return telegram !== null;
    },

    getTelegramBotUsername(): string | null {
      return telegram ? telegram.botUsername : null;
    },

    async dispose(): Promise<void> {
      await this.stopTelegram();
    },
  };
}

let singleton: ChannelRuntime | null = null;

export function getChannelRuntime(): ChannelRuntime {
  if (!singleton) singleton = createRuntime();
  return singleton;
}

/** Test-only reset so each test gets a fresh runtime. */
export function __resetChannelRuntime(): void {
  singleton = null;
}
