// shellTaskRegistry.ts — SPEC-308 T1: in-memory shell task registry with cap + rolling buffer.

import { randomUUID } from 'node:crypto';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { getGlobalBus } from './events.ts';
import { TOPICS } from './eventTypes.ts';

/** Max concurrent background tasks per workspace. */
export const MAX_TASKS_PER_WORKSPACE = 16;

/** Rolling buffer cap per task in bytes (~1MB, approximated as total char count). */
export const BUFFER_BYTE_CAP = 1_024 * 1_024;

export interface ShellTask {
  id: string;
  pid: number;
  command: string;
  workspaceId: string;
  stdout: string[];
  stderr: string[];
  stdoutBytes: number;
  stderrBytes: number;
  startTs: number;
  exitCode: number | null;
  done: boolean;
  status: 'running' | 'exited' | 'killed' | 'timed_out';
}

export interface ShellTaskRegistry {
  createTask(cmd: string, workspaceId: string, pid: number): ShellTask;
  getTask(id: string): ShellTask | undefined;
  appendStdout(id: string, line: string): void;
  appendStderr(id: string, line: string): void;
  markDone(id: string, exitCode: number): void;
  markKilled(id: string): void;
  listActive(workspaceId: string): ShellTask[];
}

export function createShellTaskRegistry(): ShellTaskRegistry {
  const tasks = new Map<string, ShellTask>();

  function countActive(workspaceId: string): number {
    let n = 0;
    for (const t of tasks.values()) {
      if (t.workspaceId === workspaceId && !t.done) n++;
    }
    return n;
  }

  function createTask(cmd: string, workspaceId: string, pid: number): ShellTask {
    const active = countActive(workspaceId);
    if (active >= MAX_TASKS_PER_WORKSPACE) {
      throw new NimbusError(ErrorCode.T_RESOURCE_LIMIT, {
        cap: MAX_TASKS_PER_WORKSPACE,
        workspaceId,
      });
    }
    const task: ShellTask = {
      id: randomUUID(),
      pid,
      command: cmd,
      workspaceId,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      startTs: Date.now(),
      exitCode: null,
      done: false,
      status: 'running',
    };
    tasks.set(task.id, task);
    return task;
  }

  function getTask(id: string): ShellTask | undefined {
    return tasks.get(id);
  }

  function rollBuffer(
    lines: string[],
    currentBytes: number,
    line: string,
    taskId: string,
    stream: 'stdout' | 'stderr',
  ): { lines: string[]; bytes: number; dropped: number } {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    let dropped = 0;

    // Drop oldest lines until we have room.
    while (lines.length > 0 && currentBytes + lineBytes > BUFFER_BYTE_CAP) {
      const oldest = lines.shift()!;
      currentBytes -= Buffer.byteLength(oldest, 'utf8');
      dropped++;
    }

    if (dropped > 0) {
      const bus = getGlobalBus();
      bus.publish(TOPICS.shell.bufferOverflow, {
        type: TOPICS.shell.bufferOverflow,
        taskId,
        droppedLines: dropped,
        stream,
      });
    }

    lines.push(line);
    currentBytes += lineBytes;
    return { lines, bytes: currentBytes, dropped };
  }

  function appendStdout(id: string, line: string): void {
    const task = tasks.get(id);
    if (!task) return;
    const result = rollBuffer(task.stdout, task.stdoutBytes, line, id, 'stdout');
    task.stdout = result.lines;
    task.stdoutBytes = result.bytes;

    const bus = getGlobalBus();
    bus.publish(TOPICS.shell.stdoutLine, {
      type: TOPICS.shell.stdoutLine,
      taskId: id,
      line,
      ts: Date.now(),
    });
  }

  function appendStderr(id: string, line: string): void {
    const task = tasks.get(id);
    if (!task) return;
    const result = rollBuffer(task.stderr, task.stderrBytes, line, id, 'stderr');
    task.stderr = result.lines;
    task.stderrBytes = result.bytes;

    const bus = getGlobalBus();
    bus.publish(TOPICS.shell.stderrLine, {
      type: TOPICS.shell.stderrLine,
      taskId: id,
      line,
      ts: Date.now(),
    });
  }

  function markDone(id: string, exitCode: number): void {
    const task = tasks.get(id);
    if (!task) return;
    task.exitCode = exitCode;
    task.done = true;
    task.status = 'exited';

    const bus = getGlobalBus();
    bus.publish(TOPICS.shell.exit, {
      type: TOPICS.shell.exit,
      taskId: id,
      exitCode,
      ts: Date.now(),
    });
  }

  function markKilled(id: string): void {
    const task = tasks.get(id);
    if (!task) return;
    task.done = true;
    task.status = 'killed';

    const bus = getGlobalBus();
    bus.publish(TOPICS.shell.exit, {
      type: TOPICS.shell.exit,
      taskId: id,
      exitCode: -1,
      ts: Date.now(),
    });
  }

  function listActive(workspaceId: string): ShellTask[] {
    const result: ShellTask[] = [];
    for (const t of tasks.values()) {
      if (t.workspaceId === workspaceId && !t.done) result.push(t);
    }
    return result;
  }

  return { createTask, getTask, appendStdout, appendStderr, markDone, markKilled, listActive };
}

// Module-level singleton for use across tools.
let _registry: ShellTaskRegistry | null = null;

export function getShellTaskRegistry(): ShellTaskRegistry {
  if (!_registry) _registry = createShellTaskRegistry();
  return _registry;
}

export function __resetShellTaskRegistry(): void {
  _registry = null;
}
