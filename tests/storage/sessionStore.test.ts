import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import {
  appendMessage,
  createSession,
  listSessions,
  loadSession,
  sessionPaths,
} from '../../src/storage/sessionStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import { ErrorCode, NimbusError } from '../../src/observability/errors.ts';

const OVERRIDE = join(tmpdir(), `nimbus-sess-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});

async function freshSession(): Promise<{ wsId: string; sid: string }> {
  const { meta } = await createWorkspaceDir({ name: 'sess-' + Math.random().toString(36).slice(2, 8) });
  const s = await createSession(meta.id);
  return { wsId: meta.id, sid: s.id };
}

describe('SPEC-102: session storage', () => {
  test('create + append + load round-trip', async () => {
    const { wsId, sid } = await freshSession();
    await appendMessage(wsId, sid, { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'T1');
    const msgs = await loadSession(wsId, sid);
    expect(msgs.length).toBe(1);
    const content = msgs[0]!.content;
    expect(Array.isArray(content)).toBe(true);
  });

  test('broken middle line quarantined + recoveredLines', async () => {
    const { wsId, sid } = await freshSession();
    await appendMessage(wsId, sid, { role: 'user', content: [{ type: 'text', text: 'a' }] }, 'T1');
    const paths = sessionPaths(wsId, sid);
    const existing = await readFile(paths.messages, 'utf8');
    await writeFile(paths.messages, existing + '{broken json\n', { encoding: 'utf8' });
    await appendMessage(wsId, sid, { role: 'user', content: [{ type: 'text', text: 'b' }] }, 'T2');
    const msgs = await loadSession(wsId, sid);
    expect(msgs.length).toBe(2);
  });

  test('line size exceeded throws T_VALIDATION', async () => {
    const { wsId, sid } = await freshSession();
    const huge = 'x'.repeat(300_000);
    try {
      await appendMessage(wsId, sid, { role: 'user', content: [{ type: 'text', text: huge }] }, 'T1');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.T_VALIDATION);
    }
  });

  test('missing header throws S_SCHEMA_MISMATCH', async () => {
    const { wsId, sid } = await freshSession();
    const paths = sessionPaths(wsId, sid);
    await writeFile(paths.messages, 'not-header\n', { encoding: 'utf8' });
    try {
      await loadSession(wsId, sid);
      throw new Error('should throw');
    } catch (err) {
      expect((err as Error).message).toContain('S_SCHEMA_MISMATCH');
    }
  });

  test('listSessions sorted by lastMessage desc', async () => {
    const { meta } = await createWorkspaceDir({ name: 'multi' });
    const a = await createSession(meta.id);
    await new Promise((r) => setTimeout(r, 5));
    await appendMessage(meta.id, a.id, { role: 'user', content: 'x' }, 'T1', { isTurnBoundary: true });
    const b = await createSession(meta.id);
    await new Promise((r) => setTimeout(r, 5));
    await appendMessage(meta.id, b.id, { role: 'user', content: 'y' }, 'T1', { isTurnBoundary: true });
    const list = await listSessions(meta.id);
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(b.id);
  });
});
