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
 *
 * SPEC-311: `startTelegram` accepts an opaque `deps` bag. The tools layer owns
 * the concrete shape (`TelegramRuntimeDeps` in src/tools/builtin/Telegram.ts:
 * `{ provider, model, registry, gate, cwd }`); at the port boundary it is
 * `unknown` so that src/core/ does not gain a type edge to src/tools/
 * (forbidden by the layer DAG). The runtime implementation casts back to its
 * own `StartTelegramOptions` shape since both sides agree structurally.
 *
 * When `deps` is omitted, the implementation MUST NOT attempt to spin up a
 * fresh adapter — it may only report `{ botUsername }` for an already-running
 * instance, otherwise throw `U_MISSING_CONFIG / reason=channel_runtime_bridge_required`.
 */
export interface ChannelService {
  /** Start the Telegram adapter. Returns bot @username once live. */
  startTelegram(wsId: string, deps?: unknown): Promise<{ botUsername: string }>;

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
