// sessionStore.ts — SPEC-102: JSONL append-only session storage with schemaVersion header.

import { appendFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { newToolUseId } from '../ir/helpers.ts';
import type { CanonicalMessage } from '../ir/types.ts';
import {
  MAX_LINE_BYTES,
  MessageLineSchema,
  SessionMetaSchema,
  type SessionMeta,
  type StoredSessionEvent,
} from '../core/sessionTypes.ts';
import { workspacePaths } from '../core/workspaceMemory.ts';

function sessionPaths(wsId: string, sessionId: string): {
  root: string;
  meta: string;
  messages: string;
  events: string;
  taskSpecs: string;
} {
  const root = join(workspacePaths(wsId).sessionsDir, sessionId);
  return {
    root,
    meta: join(root, 'meta.json'),
    messages: join(root, 'messages.jsonl'),
    events: join(root, 'events.jsonl'),
    taskSpecs: join(root, 'task-specs'),
  };
}

const HEADER_LINE = JSON.stringify({ schemaVersion: 1, type: 'header' }) + '\n';

export async function createSession(wsId: string): Promise<SessionMeta> {
  const id = newToolUseId();
  const now = Date.now();
  const meta: SessionMeta = SessionMetaSchema.parse({
    schemaVersion: 1,
    id,
    wsId,
    createdAt: now,
    lastMessage: now,
    turnCount: 0,
    tokenCount: 0,
    recoveredLines: 0,
  });
  const paths = sessionPaths(wsId, id);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.taskSpecs, { recursive: true });
  await writeFile(paths.meta, JSON.stringify(meta, null, 2), { encoding: 'utf8' });
  await writeFile(paths.messages, HEADER_LINE, { encoding: 'utf8' });
  await writeFile(paths.events, HEADER_LINE, { encoding: 'utf8' });
  return meta;
}

async function readMeta(wsId: string, sessionId: string): Promise<SessionMeta> {
  const paths = sessionPaths(wsId, sessionId);
  const raw = await readFile(paths.meta, 'utf8');
  const parsed = JSON.parse(raw);
  return SessionMetaSchema.parse(parsed);
}

async function writeMeta(wsId: string, sessionId: string, meta: SessionMeta): Promise<void> {
  const paths = sessionPaths(wsId, sessionId);
  const tmp = `${paths.meta}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf8' });
  await rename(tmp, paths.meta);
}

export async function appendMessage(
  wsId: string,
  sessionId: string,
  msg: CanonicalMessage,
  turnId: string,
  opts?: { isTurnBoundary?: boolean },
): Promise<void> {
  const paths = sessionPaths(wsId, sessionId);
  const line = JSON.stringify({ schemaVersion: 1, turnId, message: msg, ts: Date.now() });
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LINE_BYTES) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'line_size_exceeded', size: bytes });
  }
  await appendFile(paths.messages, line + '\n', { encoding: 'utf8' });
  if (opts?.isTurnBoundary) {
    const meta = await readMeta(wsId, sessionId);
    meta.lastMessage = Date.now();
    meta.turnCount += 1;
    await writeMeta(wsId, sessionId, meta);
    // rotate if messages file huge
    try {
      const st = await stat(paths.messages);
      if (st.size > 100 * 1024 * 1024) {
        const rotated = paths.messages.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
        await rename(paths.messages, rotated);
        await writeFile(paths.messages, HEADER_LINE, { encoding: 'utf8' });
      }
    } catch {
      // ignore rotation errors
    }
  }
}

export async function appendEvent(
  wsId: string,
  sessionId: string,
  ev: Omit<StoredSessionEvent, 'eventId'>,
): Promise<number> {
  const paths = sessionPaths(wsId, sessionId);
  const meta = await readMeta(wsId, sessionId);
  const eventId = meta.createdAt * 100_000 + (meta.turnCount * 1000 + Math.floor(Math.random() * 1000));
  const full = { ...ev, eventId };
  const line = JSON.stringify(full);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LINE_BYTES) {
    throw new NimbusError(ErrorCode.T_VALIDATION, { reason: 'event_line_too_large', size: bytes });
  }
  await appendFile(paths.events, line + '\n', { encoding: 'utf8' });
  return eventId;
}

export async function loadSession(wsId: string, sessionId: string): Promise<CanonicalMessage[]> {
  const paths = sessionPaths(wsId, sessionId);
  const raw = await readFile(paths.messages, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { reason: 'empty_messages_file' });
  }
  // Validate header
  let header: unknown;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { reason: 'invalid_header' });
  }
  if (!header || typeof header !== 'object' || (header as { type?: string }).type !== 'header') {
    throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { reason: 'missing_header' });
  }
  if ((header as { schemaVersion?: number }).schemaVersion !== 1) {
    throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { reason: 'bad_schema_version' });
  }

  const messages: CanonicalMessage[] = [];
  const broken: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      const parsed = JSON.parse(line);
      const validated = MessageLineSchema.parse(parsed);
      messages.push(validated.message as CanonicalMessage);
    } catch {
      broken.push(line);
    }
  }
  if (broken.length > 0) {
    const brokenPath = join(paths.root, `messages.broken.${Date.now()}.jsonl`);
    await writeFile(brokenPath, broken.join('\n') + '\n', { encoding: 'utf8' });
    try {
      const meta = await readMeta(wsId, sessionId);
      meta.recoveredLines = (meta.recoveredLines ?? 0) + broken.length;
      await writeMeta(wsId, sessionId, meta);
    } catch {
      // ignore
    }
  }
  return messages;
}

export async function listSessions(wsId: string): Promise<SessionMeta[]> {
  const dir = workspacePaths(wsId).sessionsDir;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  await Promise.all(
    entries.map(async (id) => {
      try {
        const meta = await readMeta(wsId, id);
        metas.push(meta);
      } catch {
        // skip
      }
    }),
  );
  metas.sort((a, b) => b.lastMessage - a.lastMessage);
  return metas;
}

export async function sessionExists(wsId: string, sessionId: string): Promise<boolean> {
  try {
    await lstat(sessionPaths(wsId, sessionId).meta);
    return true;
  } catch {
    return false;
  }
}

export { sessionPaths };
