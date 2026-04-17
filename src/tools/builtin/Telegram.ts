// Telegram.ts — SPEC-808 T3: tools the agent invokes to manage the Telegram channel.
// ConnectTelegram / DisconnectTelegram / TelegramStatus. sideEffects: 'exec' (network).
//
// SPEC-833: tools layer must NOT import src/channels/** directly (META-001 §2.2).
// This file now depends only on src/core/channelPorts.ts (abstract ChannelService port).
// The concrete ChannelRuntime adapter (src/channels/runtime.ts) registers itself via
// registerChannelService() at REPL startup.
//
// RuntimeBridge pattern: the REPL still sets a bridge for the full startTelegram path
// (it needs provider/model/registry/gate dependencies that tools don't own). The port
// handles status queries and stop without the bridge.

import { z } from 'zod';
import { NimbusError, ErrorCode, wrapError } from '../../observability/errors.ts';
import { getChannelService, type ChannelService } from '../../core/channelPorts.ts';
import type { Tool, ToolContext } from '../types.ts';

/**
 * Resolve the active ChannelService.
 * Tries the port registry first; if not yet registered (e.g. in tests that call
 * __resetChannelRuntime before a lazy getChannelRuntime init), returns null so
 * callers can produce the correct missing-config error.
 */
function resolveChannelService(): ChannelService | null {
  return getChannelService();
}

// ── Bridge: REPL writes here at boot; used for ConnectTelegram only ───────────
// v0.3.6 wires this in startRepl(). In tests, the bridge can be set directly.
// The bridge carries provider/model/registry/gate — deps the tools layer doesn't own.

export interface TelegramRuntimeDeps {
  provider: import('../../ir/types.ts').Provider;
  model: string;
  registry: import('../index.ts').ToolRegistry;
  gate: import('../../permissions/index.ts').Gate;
  cwd: string;
}

type RuntimeBridge = (ctx: ToolContext) => TelegramRuntimeDeps | null;
let runtimeBridge: RuntimeBridge | null = null;

export function setTelegramRuntimeBridge(bridge: RuntimeBridge | null): void {
  runtimeBridge = bridge;
}

// ── ConnectTelegram ───────────────────────────────────────────────────────────

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
        const svc = getChannelService();
        if (!svc) {
          throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'channel_service_not_registered',
            hint: 'this tool must be invoked from inside a REPL session',
          });
        }

        if (svc.isTelegramRunning()) {
          const username = svc.getTelegramBotUsername() ?? 'bot';
          const status = await svc.getTelegramStatus(ctx.workspaceId);
          return {
            ok: true,
            output: {
              botUsername: username,
              alreadyRunning: true,
              allowedUserCount: status.allowedUserIds.length,
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

        // SPEC-311: pass deps through the port as an opaque bag. The concrete
        // ChannelRuntime implementation (src/channels/runtime.ts) casts it back
        // to StartTelegramOptions and calls the real startTelegram() path that
        // validates vault config + opens the long-poll. Before SPEC-311 this
        // call silently hit the port's "bridge required" fallback because the
        // deps never left the tools layer.
        const { botUsername } = await svc.startTelegram(ctx.workspaceId, deps);
        const status = await svc.getTelegramStatus(ctx.workspaceId);
        return {
          ok: true,
          output: {
            botUsername,
            alreadyRunning: false,
            allowedUserCount: status.allowedUserIds.length,
          },
          display:
            `Telegram online as @${botUsername} — ${status.allowedUserIds.length} user(s) authorised. ` +
            'Open Telegram and send a message to the bot.',
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}

// ── DisconnectTelegram ────────────────────────────────────────────────────────

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
        const svc = getChannelService();
        if (!svc) {
          throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
            reason: 'channel_service_not_registered',
            hint: 'this tool must be invoked from inside a REPL session',
          });
        }
        const wasRunning = svc.isTelegramRunning();
        await svc.stopTelegram();
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

// ── TelegramStatus ────────────────────────────────────────────────────────────

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
        const svc = getChannelService();
        if (!svc) {
          // Outside REPL: return minimal status rather than throwing
          return {
            ok: true,
            output: { connected: false, tokenPresent: false, allowedUserIds: [] },
            display: 'Telegram: channel service not available in this context',
          };
        }
        const status = await svc.getTelegramStatus(ctx.workspaceId);
        const output: TelegramStatusOutput = {
          connected: status.connected,
          tokenPresent: status.tokenPresent,
          allowedUserIds: status.allowedUserIds,
        };
        if (status.botUsername) output.botUsername = status.botUsername;
        const display = status.connected
          ? `Telegram: online (@${status.botUsername ?? 'bot'}), ${status.allowedUserIds.length} allowed user(s)`
          : status.tokenPresent
            ? 'Telegram: offline (token saved, adapter not started)'
            : 'Telegram: offline (no token stored)';
        return { ok: true, output, display };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
