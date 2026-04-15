import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendAudit,
  computeAndAppend,
  digestInput,
  sha256Hex,
} from '../../src/observability/auditLog.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

const OVERRIDE = join(tmpdir(), `nimbus-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const SESSION = '01H0000000000000000000A000';

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});

describe('SPEC-119: audit log', () => {
  test('sha256Hex known vector', () => {
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('digestInput stable on sorted keys', () => {
    const a = digestInput({ b: 1, a: 2 });
    const b = digestInput({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test('appendAudit writes to day file', async () => {
    await appendAudit({
      schemaVersion: 1,
      ts: Date.parse('2026-04-15T10:00:00Z'),
      sessionId: SESSION,
      kind: 'tool_call',
      toolName: 'Bash',
      inputDigest: sha256Hex('x'),
      outcome: 'ok',
    });
    const path = join(OVERRIDE, 'logs', 'audit', '2026-04-15.jsonl');
    const content = await readFile(path, 'utf8');
    const line = content.trim().split('\n')[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.toolName).toBe('Bash');
  });

  test('invalid entry throws T_VALIDATION', async () => {
    try {
      await appendAudit({
        schemaVersion: 1,
        ts: 1,
        sessionId: 'not-a-ulid',
        kind: 'tool_call',
        toolName: 'X',
        inputDigest: 'nothex',
        outcome: 'ok',
      });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    }
  });

  test('computeAndAppend never writes raw input', async () => {
    await computeAndAppend({
      sessionId: SESSION,
      kind: 'tool_call',
      toolName: 'Bash',
      toolInput: { cmd: 'echo sk-ant-secret-xyz' },
      outcome: 'ok',
    });
    const dir = join(OVERRIDE, 'logs', 'audit');
    const files = await import('node:fs/promises').then((m) => m.readdir(dir));
    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8');
      expect(raw).not.toContain('sk-ant-secret');
    }
  });
});
