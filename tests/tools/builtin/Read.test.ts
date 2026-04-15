// tests/tools/builtin/Read.test.ts — SPEC-302.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadTool } from '../../../src/tools/builtin/Read.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'read-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-302: Read tool', () => {
  test('valid file returns content with line numbers', async () => {
    const f = join(root, 'a.txt');
    writeFileSync(f, 'one\ntwo\nthree');
    const tool = createReadTool();
    const res = await tool.handler({ path: f }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.content).toContain('one');
      expect(res.output.totalLines).toBe(3);
    }
  });

  test('offset/limit windowing', async () => {
    const f = join(root, 'b.txt');
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    writeFileSync(f, lines);
    const tool = createReadTool();
    const res = await tool.handler({ path: f, offset: 10, limit: 3 }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.returnedLines).toBe(3);
      expect(res.output.content).toContain('line10');
      expect(res.output.content).toContain('line12');
      expect(res.output.content).not.toContain('line13');
    }
  });

  test('binary file rejected', async () => {
    const f = join(root, 'bin.dat');
    writeFileSync(f, Buffer.from([0, 1, 2, 3, 0]));
    const tool = createReadTool();
    const res = await tool.handler({ path: f }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_VALIDATION);
  });

  test('symlink rejected (X_PATH_BLOCKED)', async () => {
    const target = join(root, 'target.txt');
    writeFileSync(target, 'x');
    const sym = join(root, 'sym.txt');
    symlinkSync(target, sym);
    const tool = createReadTool();
    const res = await tool.handler({ path: sym }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.X_PATH_BLOCKED);
  });

  test('non-existent file → T_NOT_FOUND', async () => {
    const tool = createReadTool();
    const res = await tool.handler({ path: join(root, 'nope.txt') }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_NOT_FOUND);
  });

  test('.env blocked by pathValidator', async () => {
    const env = join(root, '.env');
    writeFileSync(env, 'SECRET=x');
    const tool = createReadTool();
    const res = await tool.handler({ path: env }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.X_CRED_ACCESS);
  });
});
