// tests/tools/bashOutput.test.ts — SPEC-308 T6: BashOutput + KillBash tool tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashOutputTool } from '../../src/tools/builtin/BashOutput.ts';
import { createKillBashTool } from '../../src/tools/builtin/KillBash.ts';
import { createBashTool } from '../../src/tools/builtin/Bash.ts';
import { getShellTaskRegistry, __resetShellTaskRegistry } from '../../src/core/shellTaskRegistry.ts';
import { ErrorCode } from '../../src/observability/errors.ts';
import { __resetGlobalBus } from '../../src/core/events.ts';
import { ctxStub } from './helpers.ts';

let root: string;
let origNH: string | undefined;

beforeEach(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'bash-out-test-'));
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

describe('SPEC-308: BashOutput tool', () => {
  test('unknown taskId → U_MISSING_CONFIG', async () => {
    const tool = createBashOutputTool();
    const res = await tool.handler(
      { taskId: '00000000-0000-4000-8000-000000000000' },
      ctxStub({ cwd: root }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.U_MISSING_CONFIG);
  });

  test('returns all lines when since omitted', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo', 'W1', 100);
    reg.appendStdout(task.id, 'line0');
    reg.appendStdout(task.id, 'line1');
    reg.appendStdout(task.id, 'line2');

    const tool = createBashOutputTool();
    const res = await tool.handler(
      { taskId: task.id },
      ctxStub({ cwd: root, workspaceId: 'W1' }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.lines).toContain('line0');
      expect(res.output.lines).toContain('line2');
      expect(res.output.nextSince).toBe(3);
    }
  });

  test('since:2 returns only lines from index 2', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo', 'W1', 100);
    reg.appendStdout(task.id, 'line0');
    reg.appendStdout(task.id, 'line1');
    reg.appendStdout(task.id, 'line2');
    reg.appendStdout(task.id, 'line3');

    const tool = createBashOutputTool();
    const res = await tool.handler(
      { taskId: task.id, since: 2 },
      ctxStub({ cwd: root, workspaceId: 'W1' }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.lines).toEqual(['line2', 'line3']);
      expect(res.output.nextSince).toBe(4);
    }
  });

  test('repeated calls with advancing cursor returns only new lines', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo', 'W1', 100);
    reg.appendStdout(task.id, 'a');
    reg.appendStdout(task.id, 'b');

    const tool = createBashOutputTool();

    const res1 = await tool.handler({ taskId: task.id }, ctxStub({ cwd: root, workspaceId: 'W1' }));
    expect(res1.ok).toBe(true);
    if (!res1.ok) return;
    expect(res1.output.nextSince).toBe(2);

    // Add more lines.
    reg.appendStdout(task.id, 'c');

    const res2 = await tool.handler(
      { taskId: task.id, since: res1.output.nextSince },
      ctxStub({ cwd: root, workspaceId: 'W1' }),
    );
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.output.lines).toEqual(['c']);
    expect(res2.output.nextSince).toBe(3);
  });

  test('limit param caps returned lines', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo', 'W1', 100);
    for (let i = 0; i < 10; i++) reg.appendStdout(task.id, `l${i}`);

    const tool = createBashOutputTool();
    const res = await tool.handler(
      { taskId: task.id, since: 0, limit: 3 },
      ctxStub({ cwd: root, workspaceId: 'W1' }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output.lines).toHaveLength(3);
  });

  test('UTF-8 multi-byte line: no mid-codepoint split in appendStdout', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo', 'W1', 100);
    // Japanese string: each char is 3 bytes in UTF-8.
    const line = '日本語テスト';
    reg.appendStdout(task.id, line);

    const tool = createBashOutputTool();
    const res = await tool.handler({ taskId: task.id }, ctxStub({ cwd: root, workspaceId: 'W1' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.lines[0]).toBe(line);
    }
  });

  test('status reflects exited after markDone', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('echo done', 'W1', 100);
    reg.appendStdout(task.id, 'done');
    reg.markDone(task.id, 0);

    const tool = createBashOutputTool();
    const res = await tool.handler({ taskId: task.id }, ctxStub({ cwd: root, workspaceId: 'W1' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.status).toBe('exited');
      expect(res.output.exitCode).toBe(0);
    }
  });
});

describe('SPEC-308: KillBash tool', () => {
  test('unknown taskId → U_MISSING_CONFIG', async () => {
    const tool = createKillBashTool();
    const res = await tool.handler(
      { taskId: '00000000-0000-4000-8000-000000000001' },
      ctxStub({ cwd: root }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.U_MISSING_CONFIG);
  });

  test('wrong workspace → T_PERMISSION', async () => {
    const reg = getShellTaskRegistry();
    const task = reg.createTask('sleep 60', 'W1', 9000);

    const tool = createKillBashTool();
    // Call from workspace W2 (mismatch).
    const res = await tool.handler(
      { taskId: task.id },
      ctxStub({ cwd: root, workspaceId: 'W2' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_PERMISSION);
  });

  test('kill background sleep task: terminates within 6s', async () => {
    const bashTool = createBashTool({ shell: 'bash' });
    const spawnRes = await bashTool.handler(
      { command: 'sleep 60', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    expect(spawnRes.ok).toBe(true);
    if (!spawnRes.ok) return;

    const output = spawnRes.output as { taskId: string };
    const killTool = createKillBashTool();
    const killStart = Date.now();
    const killRes = await killTool.handler(
      { taskId: output.taskId },
      ctxStub({ cwd: root }),
    );
    const killElapsed = Date.now() - killStart;
    expect(killRes.ok).toBe(true);
    if (killRes.ok) expect(killRes.output.status).toBe('killed');
    // Should complete within 6s grace period.
    expect(killElapsed).toBeLessThan(7000);
  }, 10_000);

  test('KillBash → BashOutput shows killed status', async () => {
    const bashTool = createBashTool({ shell: 'bash' });
    const spawnRes = await bashTool.handler(
      { command: 'sleep 60', run_in_background: true, timeoutMs: 120_000 },
      ctxStub({ cwd: root }),
    );
    expect(spawnRes.ok).toBe(true);
    if (!spawnRes.ok) return;

    const output = spawnRes.output as { taskId: string };
    const killTool = createKillBashTool();
    await killTool.handler({ taskId: output.taskId }, ctxStub({ cwd: root }));

    const outputTool = createBashOutputTool();
    const outRes = await outputTool.handler(
      { taskId: output.taskId },
      ctxStub({ cwd: root }),
    );
    expect(outRes.ok).toBe(true);
    if (outRes.ok) expect(outRes.output.status).toBe('killed');
  }, 10_000);
});
