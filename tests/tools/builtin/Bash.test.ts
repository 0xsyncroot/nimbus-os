// tests/tools/builtin/Bash.test.ts — SPEC-303 integration tests.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBashTool } from '../../../src/tools/builtin/Bash.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'bash-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-303: Bash tool', () => {
  test('ls works', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler({ command: 'echo hello', timeoutMs: 5000 }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.exitCode).toBe(0);
      expect(res.output.stdout).toContain('hello');
    }
  });

  test('rm -rf / blocked pre-spawn', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler({ command: 'rm -rf /', timeoutMs: 5000 }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.X_BASH_BLOCKED);
  });

  test('timeout kills child', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler({ command: 'sleep 2', timeoutMs: 100 }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_TIMEOUT);
  });

  test('output with secret is redacted', async () => {
    const tool = createBashTool({ shell: 'bash' });
    const res = await tool.handler({
      command: "echo 'token=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ'",
      timeoutMs: 5000,
    }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.stdout).toContain('***redacted***');
      expect(res.output.stdout).not.toContain('sk-ant-api03-ABCD');
    }
  });

  test('cmd shell dispatcher fails closed', async () => {
    const tool = createBashTool({ shell: 'cmd' });
    const res = await tool.handler({ command: 'dir', timeoutMs: 5000 }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
  });
});
