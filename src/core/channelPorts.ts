// channelPorts.ts — SPEC-833: ChannelService port interface + in-process registry.
//
// Tools (src/tools/**) MUST NOT import src/channels/** directly — per META-001 §2.2
// the tools layer sits below channels in the dependency DAG and must stay pure.
//
// Instead, tools depend on this abstract port. The concrete ChannelRuntime adapter
// (src/channels/runtime.ts) registers itself at REPL startup via registerChannelService().
// In tests, a mock implementation can be registered directly.
//
// Port interface reflects the minimal surface tools need:
//   ConnectTelegram / DisconnectTelegram / TelegramStatus
// Extended capabilities (e.g. sendToChat) live in the channels layer only.

// ── ChannelService port ───────────────────────────────────────────────────────

export interface TelegramStatusInfo {
  connected: boolean;
  botUsername?: string;
  tokenPresent: boolean;
  allowedUserIds: number[];
}

/**
 * Abstract port: what the tools layer needs from the channel layer.
 * Implemented by the concrete ChannelRuntime in src/channels/runtime.ts.
 */
export interface ChannelService {
  /** Start the Telegram adapter. Returns bot @username once live. */
  startTelegram(wsId: string): Promise<{ botUsername: string }>;

  /** Stop the Telegram adapter. Idempotent. */
  stopTelegram(): Promise<void>;

  /** Whether the Telegram adapter is currently running. */
  isTelegramRunning(): boolean;

  /** @username of the running bot, or null if not started. */
  getTelegramBotUsername(): string | null;

  /** Retrieve Telegram config summary (token presence + allowed users). */
  getTelegramStatus(wsId: string): Promise<TelegramStatusInfo>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

let _service: ChannelService | null = null;

/**
 * Register the concrete ChannelService implementation.
 * Called once at REPL startup (src/channels/runtime.ts → registerChannelService).
 * Subsequent calls replace the registration (useful for tests).
 */
export function registerChannelService(impl: ChannelService): void {
  _service = impl;
}

/**
 * Retrieve the registered ChannelService.
 * Returns null if not yet registered (e.g. outside REPL context).
 */
export function getChannelService(): ChannelService | null {
  return _service;
}

/**
 * Test-only: reset registry so each test starts clean.
 */
export function __resetChannelService(): void {
  _service = null;
}
