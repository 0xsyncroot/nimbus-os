// tests/tools/builtin/Edit.test.ts — SPEC-302.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from '../../../src/tools/builtin/Edit.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'edit-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-302: Edit tool', () => {
  test('single occurrence replaced', async () => {
    const f = join(root, 'a.txt');
    writeFileSync(f, 'hello world');
    const tool = createEditTool();
    const res = await tool.handler({ path: f, oldString: 'world', newString: 'nimbus', replaceAll: false }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hello nimbus');
  });

  test('non-unique without replaceAll → T_VALIDATION', async () => {
    const f = join(root, 'b.txt');
    writeFileSync(f, 'foo foo foo');
    const tool = createEditTool();
    const res = await tool.handler({ path: f, oldString: 'foo', newString: 'bar', replaceAll: false }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_VALIDATION);
  });

  test('replaceAll replaces every occurrence', async () => {
    const f = join(root, 'c.txt');
    writeFileSync(f, 'foo foo foo');
    const tool = createEditTool();
    const res = await tool.handler({ path: f, oldString: 'foo', newString: 'bar', replaceAll: true }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('bar bar bar');
  });

  test('old_string not found → T_VALIDATION', async () => {
    const f = join(root, 'd.txt');
    writeFileSync(f, 'abc');
    const tool = createEditTool();
    const res = await tool.handler({ path: f, oldString: 'zzz', newString: 'x', replaceAll: false }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.T_VALIDATION);
  });
});
