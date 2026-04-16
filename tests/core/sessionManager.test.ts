// sessionManager.test.ts — SPEC-121: message cache for cross-turn context rehydration.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getOrCreateSession,
  getCachedMessages,
  appendToCache,
  setActiveSession,
  __resetSessionManager,
} from '../../src/core/sessionManager.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { appendMessage, createSession } from '../../src/storage/sessionStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import type { CanonicalMessage } from '../../src/ir/types.ts';

const OVERRIDE = join(tmpdir(), `nimbus-sm-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  __resetSessionManager();
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});

describe('SPEC-121: sessionManager message cache', () => {
  test('new session → empty cache', async () => {
    const { meta } = await createWorkspaceDir({ name: 'test-ws-new' });
    const session = await getOrCreateSession(meta.id);
    const msgs = getCachedMessages(session.id);
    expect(msgs).toEqual([]);
  });

  test('cache updates after each appendToCache call', async () => {
    const { meta } = await createWorkspaceDir({ name: 'test-ws-append' });
    const session = await getOrCreateSession(meta.id);

    const msg1: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
    const msg2: CanonicalMessage = { role: 'assistant', content: [{ type: 'text', text: 'world' }] };

    appendToCache(session.id, msg1);
    expect(getCachedMessages(session.id)).toHaveLength(1);

    appendToCache(session.id, msg2);
    expect(getCachedMessages(session.id)).toHaveLength(2);
    expect(getCachedMessages(session.id)[0]).toEqual(msg1);
    expect(getCachedMessages(session.id)[1]).toEqual(msg2);
  });

  test('after 2-turn conversation, 3rd getCachedMessages returns 4 prior messages', async () => {
    const { meta } = await createWorkspaceDir({ name: 'test-ws-history' });
    const session = await getOrCreateSession(meta.id);

    // Simulate 2 turns: user+assistant each
    const turnId = 'turn-001';
    const userMsg1: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'turn 1 user' }] };
    const assistantMsg1: CanonicalMessage = { role: 'assistant', content: [{ type: 'text', text: 'turn 1 assistant' }] };
    const userMsg2: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'turn 2 user' }] };
    const assistantMsg2: CanonicalMessage = { role: 'assistant', content: [{ type: 'text', text: 'turn 2 assistant' }] };

    // Persist to JSONL (as loop.ts would)
    await appendMessage(meta.id, session.id, userMsg1, turnId);
    await appendMessage(meta.id, session.id, assistantMsg1, turnId, { isTurnBoundary: true });
    await appendMessage(meta.id, session.id, userMsg2, turnId);
    await appendMessage(meta.id, session.id, assistantMsg2, turnId, { isTurnBoundary: true });

    // Also reflect in cache as repl.ts would
    appendToCache(session.id, userMsg1);
    appendToCache(session.id, assistantMsg1);
    appendToCache(session.id, userMsg2);
    appendToCache(session.id, assistantMsg2);

    // 3rd turn: getCachedMessages returns 4 prior messages
    const prior = getCachedMessages(session.id);
    expect(prior).toHaveLength(4);
    expect(prior[0]!.role).toBe('user');
    expect(prior[1]!.role).toBe('assistant');
    expect(prior[2]!.role).toBe('user');
    expect(prior[3]!.role).toBe('assistant');
  });

  test('rehydrates prior messages from JSONL on first getOrCreateSession call', async () => {
    const { meta } = await createWorkspaceDir({ name: 'test-ws-rehydrate' });

    // Create session and persist messages directly (simulate a previous process)
    const sess = await createSession(meta.id);
    const turnId = 'turn-hydrate';
    const userMsg: CanonicalMessage = { role: 'user', content: [{ type: 'text', text: 'prior user' }] };
    const assistantMsg: CanonicalMessage = { role: 'assistant', content: [{ type: 'text', text: 'prior assistant' }] };
    await appendMessage(meta.id, sess.id, userMsg, turnId);
    await appendMessage(meta.id, sess.id, assistantMsg, turnId, { isTurnBoundary: true });

    // Reset manager state (simulates process restart / new session)
    __resetSessionManager();

    // Now getOrCreateSession should rehydrate from JSONL
    const session = await getOrCreateSession(meta.id);
    expect(session.id).toBe(sess.id);
    const cached = getCachedMessages(session.id);
    expect(cached).toHaveLength(2);
    expect((cached[0]!.content as Array<{ type: string; text: string }>)[0]!.text).toBe('prior user');
    expect((cached[1]!.content as Array<{ type: string; text: string }>)[0]!.text).toBe('prior assistant');
  });
});
