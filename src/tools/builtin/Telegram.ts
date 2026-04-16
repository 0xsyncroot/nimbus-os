// Telegram.ts — SPEC-808 T3: tools the agent invokes to manage the Telegram channel.
// ConnectTelegram / DisconnectTelegram / TelegramStatus. sideEffects: 'exec' (network).
//
// The tools pull the runtime context (provider, model, registry, gate) from a
// module-level bridge that the REPL populates at startup. This keeps ToolContext
// lean (workspaceId + sessionId + signal only, per SPEC-301) while still giving
// the tool everything it needs to start a live adapter.

import { z } from 'zod';
import { NimbusError, ErrorCode, wrapError } from '../../observability/errors.ts';
import { getChannelRuntime, type StartTelegramOptions } from '../../channels/runtime.ts';
import { readSummary } from '../../channels/telegram/config.ts';
import type { Tool, ToolContext } from '../types.ts';

// ── Bridge: REPL writes here at boot; tools read at invocation time ──
// v0.3.6 wires this in startRepl(). In tests, the bridge can be set directly.

type RuntimeBridge = (ctx: ToolContext) => Omit<StartTelegramOptions, 'wsId'> | null;
let runtimeBridge: RuntimeBridge | null = null;

export function setTelegramRuntimeBridge(bridge: RuntimeBridge | null): void {
  runtimeBridge = bridge;
}

// ── ConnectTelegram ───────────────────────────────────────────────────────

export const ConnectTelegramInputSchema = z
  .object({
    /** Optional acknowledgement — future: override workspace id etc. */
    confirm: z.boolean().optional(),
  })
  .strict();
export type ConnectTelegramInput = z.infer<typeof ConnectTelegramInputSchema>;

export interface ConnectTelegramOutput {
  botUsername: string;
  alreadyRunning: boolean;
  allowedUserCount: number;
}

export function createConnectTelegramTool(): Tool<ConnectTelegramInput, ConnectTelegramOutput> {
  return {
    name: 'ConnectTelegram',
    description:
      'Start the built-in Telegram channel adapter so users can chat with nimbus via Telegram. ' +
      'Reads bot token + allowlist from the vault (previously set via `nimbus telegram set-token` / `nimbus telegram allow`). ' +
      'Returns the bot @username once long-polling is live. Use this instead of writing a custom bot script.',
    readOnly: false,
    inputSchema: ConnectTelegramInputSchema,
    async handler(_input, ctx) {
      try {
        const runtime = getChannelRuntime();
        if (runtime.isTelegramRunning()) {
          const username = runtime.getTelegramBotUsername() ?? 'bot';
          const summary = await readSummary(ctx.workspaceId);
          return {
            ok: true,
            output: {
              botUsername: username,
              alreadyRunning: true,
              allowedUserCount: summary.allowedUserIds.length,
            },
            display: `Telegram already online as @${username}`,
          };
        }
        if (!runtimeBridge) {
          throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'channel_runtime_not_wired',
            hint: 'this tool must be invoked from inside a REPL session',
          });
        }
        const deps = runtimeBridge(ctx);
        if (!deps) {
          throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'channel_runtime_deps_unavailable',
          });
        }
        const summary = await readSummary(ctx.workspaceId);
        const { botUsername } = await runtime.startTelegram({
          wsId: ctx.workspaceId,
          ...deps,
        });
        return {
          ok: true,
          output: {
            botUsername,
            alreadyRunning: false,
            allowedUserCount: summary.allowedUserIds.length,
          },
          display:
            `Telegram online as @${botUsername} — ${summary.allowedUserIds.length} user(s) authorised. ` +
            'Open Telegram and send a message to the bot.',
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}

// ── DisconnectTelegram ────────────────────────────────────────────────────

export const DisconnectTelegramInputSchema = z.object({}).strict();
export type DisconnectTelegramInput = z.infer<typeof DisconnectTelegramInputSchema>;

export interface DisconnectTelegramOutput {
  stopped: boolean;
  wasRunning: boolean;
}

export function createDisconnectTelegramTool(): Tool<
  DisconnectTelegramInput,
  DisconnectTelegramOutput
> {
  return {
    name: 'DisconnectTelegram',
    description:
      'Stop the built-in Telegram channel adapter. Idempotent — safe to call when already stopped.',
    readOnly: false,
    inputSchema: DisconnectTelegramInputSchema,
    async handler(_input, _ctx) {
      try {
        const runtime = getChannelRuntime();
        const wasRunning = runtime.isTelegramRunning();
        await runtime.stopTelegram();
        return {
          ok: true,
          output: { stopped: true, wasRunning },
          display: wasRunning ? 'Telegram adapter stopped.' : 'Telegram adapter was not running.',
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}

// ── TelegramStatus ────────────────────────────────────────────────────────

export const TelegramStatusInputSchema = z.object({}).strict();
export type TelegramStatusInput = z.infer<typeof TelegramStatusInputSchema>;

export interface TelegramStatusOutput {
  connected: boolean;
  botUsername?: string;
  tokenPresent: boolean;
  allowedUserIds: number[];
}

export function createTelegramStatusTool(): Tool<TelegramStatusInput, TelegramStatusOutput> {
  return {
    name: 'TelegramStatus',
    description:
      'Report the current Telegram channel state: whether the adapter is running, bot username if online, ' +
      'whether a token is stored in the vault, and the authorised user list.',
    readOnly: true,
    inputSchema: TelegramStatusInputSchema,
    async handler(_input, ctx) {
      try {
        const runtime = getChannelRuntime();
        const summary = await readSummary(ctx.workspaceId);
        const connected = runtime.isTelegramRunning();
        const output: TelegramStatusOutput = {
          connected,
          tokenPresent: summary.tokenPresent,
          allowedUserIds: summary.allowedUserIds,
        };
        const username = runtime.getTelegramBotUsername();
        if (username) output.botUsername = username;
        const display = connected
          ? `Telegram: online (@${username ?? 'bot'}), ${summary.allowedUserIds.length} allowed user(s)`
          : summary.tokenPresent
            ? 'Telegram: offline (token saved, adapter not started)'
            : 'Telegram: offline (no token stored)';
        return { ok: true, output, display };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
