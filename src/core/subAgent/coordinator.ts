// coordinator.ts — SPEC-130 T2+T3: sub-agent registry, spawn budget, depth guard, heartbeat.
// Coordinator tracks active sub-agents, enforces limits, and runs the heartbeat watchdog.

import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { newToolUseId } from '../../ir/helpers.ts';

export type AgentId = string;
export type SubAgentId = string;

export const MAX_CONCURRENT_PER_PARENT = 4;
export const MAX_SPAWN_DEPTH = 2;
export const HEARTBEAT_INTERVAL_MS = 3_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;

export interface SubAgentHandle {
  id: SubAgentId;
  parentId: AgentId;
  depth: number;
  abortController: AbortController;
  mailboxId: string;
  spawnedAt: number;
  lastHeartbeat: number;
}

export interface CoordinatorOpts {
  /** Override for testing. */
  now?: () => number;
  /** Override heartbeat interval in ms. */
  heartbeatIntervalMs?: number;
  /** Override dead-detection timeout in ms. */
  heartbeatTimeoutMs?: number;
}

export interface Coordinator {
  /** Register a new sub-agent handle (pre-created). */
  register(handle: SubAgentHandle): void;
  /** Remove a sub-agent when it completes or is cancelled. */
  unregister(id: SubAgentId): void;
  /** Bump the last heartbeat timestamp for a sub-agent. */
  heartbeat(id: SubAgentId): void;
  /** List active handles for a parent agent. */
  list(parentId: AgentId): SubAgentHandle[];
  /** Cancel all sub-agents belonging to a parent. */
  cancelAll(parentId: AgentId): void;
  /** Start the heartbeat watchdog loop (returns dispose fn). */
  startWatchdog(): () => void;
  /** Validate spawn is allowed: budget + depth guards. Throws on violation. */
  validateSpawn(parentId: AgentId, depth: number): void;
  /** Allocate a new SubAgentId. */
  allocId(): SubAgentId;
}

export function createCoordinator(opts: CoordinatorOpts = {}): Coordinator {
  const now = opts.now ?? (() => Date.now());
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  const handles = new Map<SubAgentId, SubAgentHandle>();

  function register(handle: SubAgentHandle): void {
    handles.set(handle.id, handle);
  }

  function unregister(id: SubAgentId): void {
    handles.delete(id);
  }

  function heartbeat(id: SubAgentId): void {
    const h = handles.get(id);
    if (h) h.lastHeartbeat = now();
  }

  function list(parentId: AgentId): SubAgentHandle[] {
    return Array.from(handles.values()).filter((h) => h.parentId === parentId);
  }

  function cancelAll(parentId: AgentId): void {
    for (const h of handles.values()) {
      if (h.parentId === parentId) {
        try { h.abortController.abort(new Error('parent_cancelled')); } catch { /* swallow */ }
        handles.delete(h.id);
      }
    }
  }

  function validateSpawn(parentId: AgentId, depth: number): void {
    // Hard cap: depth 3+ is refused.
    if (depth > MAX_SPAWN_DEPTH) {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'T_SPAWN_DEPTH_EXCEEDED',
        depth,
        max: MAX_SPAWN_DEPTH,
      });
    }

    // Budget: max 4 concurrent per parent.
    const active = list(parentId);
    if (active.length >= MAX_CONCURRENT_PER_PARENT) {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'spawn_budget_exceeded',
        parentId,
        active: active.length,
        max: MAX_CONCURRENT_PER_PARENT,
      });
    }
  }

  function allocId(): SubAgentId {
    return 'sub:' + newToolUseId();
  }

  function startWatchdog(): () => void {
    const timer = setInterval(() => {
      const ts = now();
      for (const [id, h] of handles) {
        const silence = ts - h.lastHeartbeat;
        if (silence >= heartbeatTimeoutMs) {
          logger.warn(
            { subAgentId: id, parentId: h.parentId, silenceMs: silence },
            'sub-agent heartbeat timeout — raising Y_SUBAGENT_CRASH',
          );
          try { h.abortController.abort(new Error('heartbeat_timeout')); } catch { /* swallow */ }
          handles.delete(id);
          // Raise Y_SUBAGENT_CRASH on the logger — caller will be notified via abort.
          logger.error(
            { code: ErrorCode.Y_SUBAGENT_CRASH, subAgentId: id },
            'Y_SUBAGENT_CRASH: sub-agent declared dead',
          );
        }
      }
    }, heartbeatIntervalMs);

    // Node/Bun timers with unref so the watchdog doesn't keep the process alive.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }

    return () => clearInterval(timer);
  }

  return { register, unregister, heartbeat, list, cancelAll, startWatchdog, validateSpawn, allocId };
}

/** Module-level singleton coordinator (lazily created). */
let globalCoordinator: Coordinator | null = null;

export function getGlobalCoordinator(): Coordinator {
  if (!globalCoordinator) globalCoordinator = createCoordinator();
  return globalCoordinator;
}

export function __resetGlobalCoordinator(): void {
  globalCoordinator = null;
}
