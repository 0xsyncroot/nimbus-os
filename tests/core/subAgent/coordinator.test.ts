import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createCoordinator,
  MAX_CONCURRENT_PER_PARENT,
  MAX_SPAWN_DEPTH,
  type SubAgentHandle,
} from '../../../src/core/subAgent/coordinator.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';
import { NimbusError } from '../../../src/observability/errors.ts';

function makeHandle(id: string, parentId: string, depth: number, now: number): SubAgentHandle {
  return {
    id,
    parentId,
    depth,
    abortController: new AbortController(),
    mailboxId: 'mailbox:' + id,
    spawnedAt: now,
    lastHeartbeat: now,
  };
}

describe('SPEC-130: coordinator', () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
  });

  test('register + list by parentId', () => {
    const coord = createCoordinator();
    const h1 = makeHandle('sub-1', 'parent-A', 1, now);
    const h2 = makeHandle('sub-2', 'parent-A', 1, now);
    const h3 = makeHandle('sub-3', 'parent-B', 1, now);
    coord.register(h1);
    coord.register(h2);
    coord.register(h3);
    const listA = coord.list('parent-A');
    expect(listA).toHaveLength(2);
    expect(listA.map((h) => h.id)).toContain('sub-1');
    expect(listA.map((h) => h.id)).toContain('sub-2');
    const listB = coord.list('parent-B');
    expect(listB).toHaveLength(1);
  });

  test('unregister removes handle', () => {
    const coord = createCoordinator();
    const h = makeHandle('sub-1', 'parent-A', 1, now);
    coord.register(h);
    coord.unregister('sub-1');
    expect(coord.list('parent-A')).toHaveLength(0);
  });

  test('cancelAll aborts all children and removes them', () => {
    const coord = createCoordinator();
    const h1 = makeHandle('sub-1', 'parent-A', 1, now);
    const h2 = makeHandle('sub-2', 'parent-A', 1, now);
    coord.register(h1);
    coord.register(h2);
    coord.cancelAll('parent-A');
    expect(h1.abortController.signal.aborted).toBe(true);
    expect(h2.abortController.signal.aborted).toBe(true);
    expect(coord.list('parent-A')).toHaveLength(0);
  });

  test('heartbeat bumps lastHeartbeat', () => {
    const mockNow = { t: 1000 };
    const coord = createCoordinator({ now: () => mockNow.t });
    const h = makeHandle('sub-1', 'parent-A', 1, mockNow.t);
    coord.register(h);
    mockNow.t = 2000;
    coord.heartbeat('sub-1');
    expect(h.lastHeartbeat).toBe(2000);
  });

  test(`validateSpawn: allows up to ${MAX_CONCURRENT_PER_PARENT} per parent`, () => {
    const coord = createCoordinator();
    for (let i = 0; i < MAX_CONCURRENT_PER_PARENT; i++) {
      const h = makeHandle(`sub-${i}`, 'parent-A', 1, now);
      coord.register(h);
    }
    expect(() => coord.validateSpawn('parent-A', 1)).toThrow(NimbusError);
    try {
      coord.validateSpawn('parent-A', 1);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
      expect((err as NimbusError).context['reason']).toBe('spawn_budget_exceeded');
    }
  });

  test(`validateSpawn: throws T_PERMISSION with T_SPAWN_DEPTH_EXCEEDED at depth ${MAX_SPAWN_DEPTH + 1}`, () => {
    const coord = createCoordinator();
    expect(() => coord.validateSpawn('parent-A', MAX_SPAWN_DEPTH + 1)).toThrow(NimbusError);
    try {
      coord.validateSpawn('parent-A', MAX_SPAWN_DEPTH + 1);
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
      expect((err as NimbusError).context['reason']).toBe('T_SPAWN_DEPTH_EXCEEDED');
    }
  });

  test('watchdog detects dead agent after timeout', async () => {
    const mockNow = { t: 1000 };
    const coord = createCoordinator({
      now: () => mockNow.t,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    const h = makeHandle('sub-dead', 'parent-A', 1, mockNow.t);
    coord.register(h);
    const stop = coord.startWatchdog();

    // Advance time past timeout without sending a heartbeat.
    mockNow.t = 1200; // 200ms silence > 100ms timeout

    // Wait for watchdog to fire.
    await new Promise((r) => setTimeout(r, 50));
    stop();

    // Sub-agent should have been aborted and removed.
    expect(h.abortController.signal.aborted).toBe(true);
    expect(coord.list('parent-A')).toHaveLength(0);
  });

  test('allocId returns unique IDs', () => {
    const coord = createCoordinator();
    const id1 = coord.allocId();
    const id2 = coord.allocId();
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('sub:')).toBe(true);
  });
});
