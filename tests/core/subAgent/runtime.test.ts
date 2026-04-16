import { describe, test, expect } from 'bun:test';
import {
  createSubAgentRuntime,
} from '../../../src/core/subAgent/runtime.ts';
import { createCoordinator } from '../../../src/core/subAgent/coordinator.ts';
import { narrow, defaultParentPermissions } from '../../../src/core/subAgent/permissions.ts';
import { ErrorCode, NimbusError } from '../../../src/observability/errors.ts';

describe('SPEC-130: permission lattice (narrow)', () => {
  test('child inherits parent mode when no override', () => {
    const parent = defaultParentPermissions('default');
    const child = narrow(parent, {});
    expect(child.mode).toBe('default');
  });

  test('parent default + child requests readonly → OK (narrowing)', () => {
    const parent = defaultParentPermissions('default');
    const child = narrow(parent, { mode: 'readonly' });
    expect(child.mode).toBe('readonly');
  });

  test('parent readonly + child requests default → throws T_PERMISSION', () => {
    const parent = defaultParentPermissions('readonly');
    expect(() => narrow(parent, { mode: 'default' })).toThrow(NimbusError);
    try {
      narrow(parent, { mode: 'default' });
    } catch (err) {
      expect((err as NimbusError).code).toBe(ErrorCode.T_PERMISSION);
      expect((err as NimbusError).context['reason']).toBe('sub_agent_mode_wider_than_parent');
    }
  });

  test('parent readonly + child requests bypass → throws T_PERMISSION', () => {
    const parent = defaultParentPermissions('readonly');
    expect(() => narrow(parent, { mode: 'bypass' })).toThrow(NimbusError);
  });

  test('bash allowlist: intersection only', () => {
    const parent = defaultParentPermissions('default');
    parent.allowedBashPatterns = ['ls', 'cat', 'echo'];
    const child = narrow(parent, { narrowBash: ['ls', 'rm', 'cat'] });
    // Only 'ls' and 'cat' are in parent — 'rm' is excluded.
    expect(child.allowedBashPatterns.sort()).toEqual(['cat', 'ls']);
  });

  test('bash: empty request results in empty allowlist', () => {
    const parent = defaultParentPermissions('default');
    parent.allowedBashPatterns = ['ls', 'cat'];
    const child = narrow(parent, { narrowBash: [] });
    expect(child.allowedBashPatterns).toEqual([]);
  });

  test('denyTools union: child adds extra denies', () => {
    const parent = defaultParentPermissions('default');
    parent.deniedTools.add('Bash');
    const child = narrow(parent, { denyTools: ['Write', 'Edit'] });
    expect(child.deniedTools.has('Bash')).toBe(true);
    expect(child.deniedTools.has('Write')).toBe(true);
    expect(child.deniedTools.has('Edit')).toBe(true);
  });

  test('parent deny + child cannot remove the deny', () => {
    const parent = defaultParentPermissions('default');
    parent.deniedTools.add('Bash');
    // Child passes empty denyTools; Bash should still be denied from parent.
    const child = narrow(parent, { denyTools: [] });
    expect(child.deniedTools.has('Bash')).toBe(true);
  });
});

describe('SPEC-130: runtime spawn', () => {
  test('runtime throws U_NOT_IMPLEMENTED for non-inproc backend', async () => {
    const runtime = createSubAgentRuntime({ backend: 'worker' });
    const ac = new AbortController();
    const ctx = {
      sessionId: 'sess-1',
      wsId: 'ws-1',
      channel: 'cli' as const,
      mode: 'default' as const,
      abort: ac as never,
      provider: {} as never,
      model: 'test',
    };
    await expect(
      runtime.spawn({
        parentId: 'parent-1',
        parentSignal: ac.signal,
        parentMode: 'default',
        prompt: 'hello',
        ctx,
      }),
    ).rejects.toThrow(NimbusError);
  });

  test('depth guard: depth > MAX_SPAWN_DEPTH throws via coordinator', () => {
    const coord = createCoordinator();
    const runtime = createSubAgentRuntime({ backend: 'inproc' }, coord);
    const ac = new AbortController();
    const ctx = {
      sessionId: 'sess-deep',
      wsId: 'ws-1',
      channel: 'cli' as const,
      mode: 'default' as const,
      abort: ac as never,
      provider: {} as never,
      model: 'test',
    };
    // parentDepth=2, so depth will be 3 — exceeds MAX_SPAWN_DEPTH=2.
    expect(
      runtime.spawn({
        parentId: 'parent-deep',
        parentSignal: ac.signal,
        parentMode: 'default',
        parentDepth: 2,
        prompt: 'deep',
        ctx,
      }),
    ).rejects.toBeInstanceOf(NimbusError);
  });

  test('budget guard: 5th concurrent spawn throws', async () => {
    const coord = createCoordinator();
    // Pre-register 4 handles to fill the budget.
    for (let i = 0; i < 4; i++) {
      coord.register({
        id: `sub-${i}`,
        parentId: 'parent-budget',
        depth: 1,
        abortController: new AbortController(),
        mailboxId: 'box-' + i,
        spawnedAt: Date.now(),
        lastHeartbeat: Date.now(),
      });
    }
    const runtime = createSubAgentRuntime({ backend: 'inproc' }, coord);
    const ac = new AbortController();
    const ctx = {
      sessionId: 'sess-budget',
      wsId: 'ws-1',
      channel: 'cli' as const,
      mode: 'default' as const,
      abort: ac as never,
      provider: {} as never,
      model: 'test',
    };
    await expect(
      runtime.spawn({
        parentId: 'parent-budget',
        parentSignal: ac.signal,
        parentMode: 'default',
        prompt: 'fifth spawn',
        ctx,
      }),
    ).rejects.toThrow(NimbusError);
  });

  test('list returns handles for parent', () => {
    const coord = createCoordinator();
    coord.register({
      id: 'sub-list-1',
      parentId: 'parent-list',
      depth: 1,
      abortController: new AbortController(),
      mailboxId: 'box-1',
      spawnedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    const runtime = createSubAgentRuntime({ backend: 'inproc' }, coord);
    expect(runtime.list('parent-list')).toHaveLength(1);
  });
});
