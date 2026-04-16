// sessionManager.ts — SPEC-102: in-memory cache for active session + LRU eviction.
// SPEC-121: message cache for cross-turn context rehydration.

import type { Disposable } from './events.ts';
import type { SessionMeta, StoredSessionEvent } from './sessionTypes.ts';
import type { CanonicalMessage } from '../ir/types.ts';
import { createSession, listSessions, loadSession } from '../storage/sessionStore.ts';

const IDLE_EVICT_MS = 10 * 60 * 1000;

const activeByWs = new Map<string, { meta: SessionMeta; lastUsed: number }>();
const eventSubs = new Map<string, Set<(ev: StoredSessionEvent) => void>>();
// SPEC-121: per-session message cache (sessionId → CanonicalMessage[])
const messageCache = new Map<string, CanonicalMessage[]>();

export async function getOrCreateSession(wsId: string): Promise<SessionMeta> {
  const current = activeByWs.get(wsId);
  if (current && Date.now() - current.lastUsed < IDLE_EVICT_MS) {
    current.lastUsed = Date.now();
    return current.meta;
  }
  const sessions = await listSessions(wsId);
  if (sessions.length > 0 && sessions[0]) {
    const meta = sessions[0];
    activeByWs.set(wsId, { meta, lastUsed: Date.now() });
    // Load prior messages into cache if not already cached
    if (!messageCache.has(meta.id)) {
      try {
        const msgs = await loadSession(wsId, meta.id);
        messageCache.set(meta.id, msgs);
      } catch {
        messageCache.set(meta.id, []);
      }
    }
    return meta;
  }
  const created = await createSession(wsId);
  activeByWs.set(wsId, { meta: created, lastUsed: Date.now() });
  messageCache.set(created.id, []);
  return created;
}

export function getCachedMessages(sessionId: string): CanonicalMessage[] {
  return messageCache.get(sessionId) ?? [];
}

export function appendToCache(sessionId: string, msg: CanonicalMessage): void {
  const existing = messageCache.get(sessionId);
  if (existing) {
    existing.push(msg);
  } else {
    messageCache.set(sessionId, [msg]);
  }
}

export function getActiveSession(wsId: string): SessionMeta | null {
  const current = activeByWs.get(wsId);
  if (!current) return null;
  if (Date.now() - current.lastUsed > IDLE_EVICT_MS) {
    activeByWs.delete(wsId);
    return null;
  }
  return current.meta;
}

export async function setActiveSession(wsId: string, meta: SessionMeta): Promise<void> {
  activeByWs.set(wsId, { meta, lastUsed: Date.now() });
  // Reset message cache for new/switched session
  if (!messageCache.has(meta.id)) {
    messageCache.set(meta.id, []);
  }
}

export function subscribeEvents(
  sessionId: string,
  cb: (ev: StoredSessionEvent) => void,
): Disposable {
  let set = eventSubs.get(sessionId);
  if (!set) {
    set = new Set();
    eventSubs.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    const s = eventSubs.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) eventSubs.delete(sessionId);
  };
}

export function publishSessionEvent(sessionId: string, ev: StoredSessionEvent): void {
  const subs = eventSubs.get(sessionId);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(ev);
    } catch {
      // swallow
    }
  }
}

export function __resetSessionManager(): void {
  activeByWs.clear();
  eventSubs.clear();
  messageCache.clear();
}
