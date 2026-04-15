// tests/tools/builtin/Grep.test.ts — SPEC-302.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrepTool } from '../../../src/tools/builtin/Grep.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'grep-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-302: Grep tool (JS fallback)', () => {
  test('content mode returns matches', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello world\nfoo bar');
    writeFileSync(join(root, 'b.txt'), 'another line');
    const tool = createGrepTool({ rgPath: null });
    const res = await tool.handler({
      pattern: 'hello',
      path: root,
      mode: 'content',
      caseInsensitive: false,
      headLimit: 10,
    }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output.text).toContain('hello world');
  });

  test('files_with_matches mode', async () => {
    const tool = createGrepTool({ rgPath: null });
    const res = await tool.handler({
      pattern: 'foo',
      path: root,
      mode: 'files_with_matches',
      caseInsensitive: false,
      headLimit: 10,
    }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output.text).toContain('a.txt');
  });

  test('secret redaction', async () => {
    writeFileSync(join(root, 'secret.txt'), 'token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAA');
    const tool = createGrepTool({ rgPath: null });
    const res = await tool.handler({
      pattern: 'token',
      path: root,
      mode: 'content',
      caseInsensitive: false,
      headLimit: 10,
    }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.text).toContain('***redacted***');
      expect(res.output.text).not.toContain('sk-ant-api03-AAAA');
    }
  });
});
