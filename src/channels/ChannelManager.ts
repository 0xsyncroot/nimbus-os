// ChannelManager.ts — SPEC-802 T4: singleton registry + event-bus bridge.
// Registers, starts, and stops adapters; bridges inbound events to SPEC-118 EventBus.

import type { ChannelAdapter } from './ChannelAdapter.ts';
import type { EventBus } from '../core/events.ts';
import { TOPICS } from '../core/eventTypes.ts';
import type { ChannelInboundEvent } from '../core/eventTypes.ts';
import { logger } from '../observability/logger.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';

export interface ChannelManager {
  /** Register an adapter. Must be called before startAll(). */
  register(adapter: ChannelAdapter): void;
  /** Start all registered adapters. Idempotent per adapter. */
  startAll(): Promise<void>;
  /** Stop all registered adapters gracefully. */
  stopAll(): Promise<void>;
  /** Publish a channel.inbound event from an adapter. Called by adapters on
   *  receiving a message from their upstream. */
  publishInbound(event: Omit<ChannelInboundEvent, 'type'>): void;
}

export function createChannelManager(bus: EventBus): ChannelManager {
  const adapters = new Map<string, ChannelAdapter>();
  const started = new Set<string>();

  function register(adapter: ChannelAdapter): void {
    if (adapters.has(adapter.id)) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'duplicate_adapter_id',
        adapterId: adapter.id,
      });
    }
    adapters.set(adapter.id, adapter);
    logger.info({ adapterId: adapter.id }, 'channel adapter registered');
  }

  async function startAll(): Promise<void> {
    const errors: Array<{ id: string; err: unknown }> = [];
    await Promise.allSettled(
      Array.from(adapters.values()).map(async (adapter) => {
        if (started.has(adapter.id)) return;
        try {
          await adapter.start();
          started.add(adapter.id);
          logger.info({ adapterId: adapter.id }, 'channel adapter started');
        } catch (err) {
          errors.push({ id: adapter.id, err });
          logger.error({ adapterId: adapter.id, err }, 'channel adapter failed to start');
        }
      }),
    );
    if (errors.length > 0) {
      throw new NimbusError(ErrorCode.Y_DAEMON_CRASH, {
        reason: 'channel_start_failures',
        failed: errors.map((e) => e.id),
      });
    }
  }

  async function stopAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(adapters.values()).map(async (adapter) => {
        if (!started.has(adapter.id)) return;
        try {
          await adapter.stop();
          started.delete(adapter.id);
          logger.info({ adapterId: adapter.id }, 'channel adapter stopped');
        } catch (err) {
          logger.error({ adapterId: adapter.id, err }, 'channel adapter failed to stop');
        }
      }),
    );
  }

  function publishInbound(partial: Omit<ChannelInboundEvent, 'type'>): void {
    if (!partial.workspaceId || typeof partial.workspaceId !== 'string') {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'missing_workspace_id',
      });
    }
    const event: ChannelInboundEvent = { type: 'channel.inbound', ...partial };
    // Log only payload digest for observability — never the raw message body.
    logger.debug(
      {
        adapterId: event.adapterId,
        workspaceId: event.workspaceId,
        userId: event.userId,
        payloadDigest: hashText(event.text),
      },
      'channel.inbound',
    );
    bus.publish(TOPICS.channel.inbound, event);
  }

  return { register, startAll, stopAll, publishInbound };
}

/** Lightweight FNV-1a 32-bit digest for log observability (not crypto). */
function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
