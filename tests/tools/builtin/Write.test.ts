// tests/tools/builtin/Write.test.ts — SPEC-302.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../../../src/tools/builtin/Write.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ErrorCode } from '../../../src/observability/errors.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'write-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-302: Write tool', () => {
  test('write + re-read round-trip', async () => {
    const f = join(root, 'out.txt');
    const tool = createWriteTool();
    const res = await tool.handler({ path: f, content: 'hello' }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hello');
  });

  test('outside workspace blocked via .env pattern in path', async () => {
    const tool = createWriteTool();
    const res = await tool.handler({ path: join(root, '.env'), content: 'SECRET=1' }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe(ErrorCode.X_CRED_ACCESS);
  });

  test('relative path resolves to cwd', async () => {
    const tool = createWriteTool();
    const res = await tool.handler({ path: 'rel.txt', content: 'ok' }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'rel.txt'), 'utf8')).toBe('ok');
  });
});
