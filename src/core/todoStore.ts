// todoStore.ts — SPEC-132: append-only JSONL todo snapshots + in-memory cache.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../observability/logger.ts';
import { workspacePaths } from './workspaceMemory.ts';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1).max(500),
  activeForm: z.string().min(1).max(500),
  status: TodoStatusSchema,
  priority: z.enum(['low', 'medium', 'high']).optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoSnapshotSchema = z.object({
  turnId: z.string().min(1),
  items: z.array(TodoItemSchema).max(20),
  ts: z.number().int().positive(),
});
export type TodoSnapshot = z.infer<typeof TodoSnapshotSchema>;

// ── Diff ────────────────────────────────────────────────────────────────────

export interface TodoDiff {
  added: TodoItem[];
  statusChanged: Array<{ prev: TodoStatus; next: TodoItem }>;
  removed: TodoItem[];
}

export function diffSnapshots(prev: TodoSnapshot | null, next: TodoSnapshot): TodoDiff {
  const prevMap = new Map<string, TodoItem>();
  if (prev) {
    for (const item of prev.items) prevMap.set(item.id, item);
  }
  const nextMap = new Map<string, TodoItem>();
  for (const item of next.items) nextMap.set(item.id, item);

  const added: TodoItem[] = [];
  const statusChanged: Array<{ prev: TodoStatus; next: TodoItem }> = [];
  const removed: TodoItem[] = [];

  for (const item of next.items) {
    const p = prevMap.get(item.id);
    if (!p) {
      added.push(item);
    } else if (p.status !== item.status) {
      statusChanged.push({ prev: p.status, next: item });
    }
  }
  for (const item of (prev?.items ?? [])) {
    if (!nextMap.has(item.id)) removed.push(item);
  }
  return { added, statusChanged, removed };
}

// ── Validation ───────────────────────────────────────────────────────────────

export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoValidationError';
  }
}

export function validateSnapshot(snapshot: TodoSnapshot): void {
  const inProgress = snapshot.items.filter((i) => i.status === 'in_progress');
  if (inProgress.length > 1) {
    throw new TodoValidationError(
      `Exactly 1 in_progress item allowed; got ${inProgress.length}: ${inProgress.map((i) => i.id).join(', ')}`,
    );
  }
}

// ── Store interface ──────────────────────────────────────────────────────────

export interface TodoStore {
  append(wsId: string, sessionId: string, snapshot: TodoSnapshot): Promise<void>;
  readLatest(wsId: string, sessionId: string): Promise<TodoSnapshot | null>;
  readAll(wsId: string, sessionId: string): Promise<TodoSnapshot[]>;
  getCached(sessionId: string): TodoSnapshot | null;
}

// ── JSONL helpers ────────────────────────────────────────────────────────────

function todosPath(wsId: string, sessionId: string): string {
  return join(workspacePaths(wsId).sessionsDir, sessionId, 'todos.jsonl');
}

// ── In-memory cache ──────────────────────────────────────────────────────────

const memCache = new Map<string, TodoSnapshot>();

// ── Implementation ───────────────────────────────────────────────────────────

export function createTodoStore(): TodoStore {
  return {
    async append(wsId, sessionId, snapshot) {
      validateSnapshot(snapshot);
      memCache.set(sessionId, snapshot);
      // Fire-and-forget persistence
      const path = todosPath(wsId, sessionId);
      const line = JSON.stringify(snapshot) + '\n';
      appendFile(path, line, 'utf8').catch((err: unknown) => {
        // Try to create directory then retry once
        const dirPath = join(workspacePaths(wsId).sessionsDir, sessionId);
        mkdir(dirPath, { recursive: true })
          .then(() => appendFile(path, line, 'utf8'))
          .catch((e: unknown) => {
            logger.warn({ err: (e as Error).message, sessionId }, 'todos.jsonl append failed');
          });
        logger.warn({ err: (err as Error).message, sessionId }, 'todos.jsonl initial append failed');
      });
    },

    async readLatest(wsId, sessionId) {
      const cached = memCache.get(sessionId);
      if (cached) return cached;
      const all = await this.readAll(wsId, sessionId);
      return all.length > 0 ? (all[all.length - 1] ?? null) : null;
    },

    async readAll(wsId, sessionId) {
      const path = todosPath(wsId, sessionId);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return [];
      }
      const snapshots: TodoSnapshot[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = TodoSnapshotSchema.parse(JSON.parse(trimmed));
          snapshots.push(parsed);
        } catch (err) {
          logger.warn({ err: (err as Error).message, sessionId }, 'invalid todos.jsonl line skipped');
        }
      }
      return snapshots;
    },

    getCached(sessionId) {
      return memCache.get(sessionId) ?? null;
    },
  };
}

/** Module-level singleton for use across the process. */
export const todoStore: TodoStore = createTodoStore();
