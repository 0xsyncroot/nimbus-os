// tests/tools/builtin/Glob.test.ts — SPEC-302.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobTool } from '../../../src/tools/builtin/Glob.ts';
import { __resetPathValidatorCache } from '../../../src/permissions/pathValidator.ts';
import { ctxStub } from '../helpers.ts';

let root: string;
let origNH: string | undefined;

beforeAll(() => {
  origNH = process.env['NIMBUS_HOME'];
  root = mkdtempSync(join(tmpdir(), 'glob-test-'));
  process.env['NIMBUS_HOME'] = join(root, '.nimbus');
  __resetPathValidatorCache();
  writeFileSync(join(root, 'a.ts'), 'x');
  writeFileSync(join(root, 'b.ts'), 'x');
  writeFileSync(join(root, 'c.md'), 'x');
});
afterAll(() => {
  if (origNH !== undefined) process.env['NIMBUS_HOME'] = origNH;
  else delete process.env['NIMBUS_HOME'];
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  __resetPathValidatorCache();
});

describe('SPEC-302: Glob tool', () => {
  test('returns matching .ts files', async () => {
    const tool = createGlobTool();
    const res = await tool.handler({ pattern: '*.ts', path: root }, ctxStub({ cwd: root }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output.matches.some((p) => p.endsWith('a.ts'))).toBe(true);
      expect(res.output.matches.some((p) => p.endsWith('c.md'))).toBe(false);
    }
  });
});
