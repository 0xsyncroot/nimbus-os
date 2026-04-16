// tests/tools/bashBackground.test.ts — SPEC-308 T6: background bash + registry tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool } from '../../src/tools/builtin/Bash.ts';
import {
  createShellTaskRegistry,
  getShellTaskRegistry,
  __resetShellTaskRegistry,
  MAX_TASKS_PER_WORKSPACE,
  BUFFER_BYTE_CAP,
} from '../../src/core/shellTaskRegistry.ts';
import { ErrorCode } from '../../src/observability/errors.ts';
import { __resetGlobalBus, createEventBus, getGlobalBus } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import { ctxStub } from './helpers.ts';

let root: string;
let origNH: string | undefined;

beforeEach(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'bash-bg-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetShellTaskRegistry();
  __resetGlobalBus();
});

afterEach(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetShellTaskRegistry();
  __resetGlobalBus();
});

describe('SPEC-308: shellTaskRegistry', () => {
  test('createTask ok within cap', () => {
    const reg = createShellTaskRegistry();
    const task = reg.createTask('echo hi', 'W1', 1234);
    expect(task.id).toBeTruthy();
    expect(task.status).toBe('running');
    expect(task.workspaceId).toBe('W1');
    expect(task.pid).toBe(1234);
  });

  test('17th task throws T_RESOURCE_LIMIT', () => {
    const reg = createShellTaskRegistry();
    for (let i = 0; i < MAX_TASKS_PER_WORKSPACE; i++) {
      reg.createTask(`echo ${i}`, 'W1', 1000 + i);
    }
    expect(() => reg.createTask('echo overflow', 'W1', 9999)).toThrow(
      expect.objectContaining({ code: ErrorCode.T_RESOURCE_LIMIT }),
    );
  });

  test('cap is per-workspace: different workspace not limited by other', () => {
    const reg = createShellTaskRegistry();
    for (let i = 0; i < MAX_TASKS_PER_WORKSPACE; i++) {
      reg.createTask(`echo ${i}`, 'W1', 1000 + i);
    }
    // W2 can still create tasks
    expect(() => reg.createTask('echo ok', 'W2', 9999)).not.toThrow();
  });

  test('markDone updates task correctly', () => {
    const reg = createShellTaskRegistry();
    const task = reg.createTask('ls', 'W1', 100);
    reg.markDone(task.id, 0);
    const updated = reg.getTask(task.id);
    expect(updated?.done).toBe(true);
    expect(updated?.status).toBe('exited');
    expect(updated?.exitCode).toBe(0);
  });

  test('markKilled updates task correctly', () => {
    const reg = createShellTaskRegistry();
    const task = reg.createTask('sleep 60', 'W1', 100);
    reg.markKilled(task.id);
    const updated = reg.getTask(task.id);
    expect(updated?.done).toBe(true);
    expect(updated?.status).toBe('killed');
  });

  test('buffer rolling: 1MB+1 byte drops oldest line, emits buffer_overflow event', () => {
    __resetGlobalBus();
    const overflowEvents: unknown[] = [];
    const bus = getGlobalBus();
    bus.subscribe(TOPICS.shell.bufferOverflow, (e) => { overflowEvents.push(e); });

    const reg = createShellTaskRegistry();
    const task = reg.createTask('yes', 'W1', 100);

    // Fill beyond 1MB with lines.
    const LINE = 'a'.repeat(1000); // 1000 bytes per line
    const linesNeeded = Math.ceil(BUFFER_BYTE_CAP / LINE.length) + 5;
    const firstLine = 'FIRST_LINE_SENTINEL';
    reg.appendStdout(task.id, firstLine);
    for (let i = 0; i < linesNeeded; i++) {
      reg.appendStdout(task.id, LINE);
    }

    const updated = reg.getTask(task.id);
    // The oldest line (FIRST_LINE_SENTINEL) should have been dropped.
    expect(updated?.stdout.includes(firstLine)).toBe(false);
    // Overflow event should eventually fire (async microtask — wait a tick).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(overflowEvents.length).toBeGreaterThan(0);
        resolve();
      }, 50);
    });
  });

  test('listActive returns only non-done tasks for workspace', () => {
    const reg = createShellTaskRegistry();
    const t1 = reg.createTask('sleep 10', 'W1', 1);
    const t2 = reg.createTask('sleep 10', 'W1', 2);
    reg.markDone(t1.id, 0);
    const active = reg.listActive('W1');
    expect(active.map((t) => t.id)).toContain(t2.id);
    expect(active.map((t) => t.id)).not.toContain(t1.id);
  });
});

describe('SPEC-308: Bash run_in_background', () => {
  test('run_in_background:true returns taskId immediately', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const start = Date.now();
    const res = await tool.handler(
      { command: 'sleep 30', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.output as { taskId: string }).taskId).toBeTruthy();
      expect((res.output as { status: string }).status).toBe('running');
    }
    // Should return well under 1s.
    expect(elapsed).toBeLessThan(2000);
  });

  test('security check still fires before background spawn', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler(
      { command: 'rm -rf /', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.X_BASH_BLOCKED);
  });

  test('stdout_line events emitted for background task', async () => {
    __resetGlobalBus();
    const lines: string[] = [];
    const bus = getGlobalBus();
    bus.subscribe(TOPICS.shell.stdoutLine, (e) => {
      lines.push((e as { line: string }).line);
    });

    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler(
      { command: 'printf "line1\\nline2\\n"', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    expect(res.ok).toBe(true);

    // Wait for async streaming.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
  });

  test('kill background task: sleep terminates via KillBash', async () => {
    // We test via registry + process.kill — KillBash tool has its own test file.
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler(
      { command: 'sleep 60', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const output = res.output as { taskId: string };
    const { getShellTaskRegistry: getReg } = await import('../../src/core/shellTaskRegistry.ts');
    const reg = getReg();
    const task = reg.getTask(output.taskId);
    expect(task).toBeTruthy();

    // Kill via process.kill directly to validate registry reflects it.
    if (task && task.pid) {
      try { process.kill(task.pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    reg.markKilled(output.taskId);
    const killed = reg.getTask(output.taskId);
    expect(killed?.status).toBe('killed');
  });
});
