// useTasks.ts — SPEC-848: React hook that subscribes to tools.todoUpdate event bus topic.
// Returns a live Task[] array; cleans up subscription + TTL interval on unmount.
// Layer rule (SPEC-833): channels/cli/ must NOT import src/tools/ directly.
// Tasks received via event bus topic only.

import { useState, useEffect } from 'react';
import { getGlobalBus } from '../../../../core/events.ts';
import { TOPICS } from '../../../../core/eventTypes.ts';
import type { TodoUpdateEvent } from '../../../../core/eventTypes.ts';

// ── Task interface (SPEC-848 §7) ───────────────────────────────────────────────
export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  owner?: string;
  blockedBy?: string[];
  /** Epoch ms — set when status transitions to 'done'. */
  completedAt?: number;
}

/** TTL for recently-completed tasks (ms). After this they are removed. */
export const TASK_DONE_TTL_MS = 30_000;

/** TTL sweep interval (ms). */
const TTL_SWEEP_INTERVAL_MS = 5_000;

/**
 * useTasks — subscribes to the event bus `tools.todoUpdate` topic.
 * Returns a stable Task[] that is updated on each publish.
 * Completed tasks linger for TASK_DONE_TTL_MS then are swept.
 */
export function useTasks(): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    const bus = getGlobalBus();

    // Subscribe to task updates from the event bus.
    const dispose = bus.subscribe<TodoUpdateEvent>(
      TOPICS.tools.todoUpdate,
      (event) => {
        const now = Date.now();
        const updated: Task[] = event.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          owner: t.owner,
          blockedBy: t.blockedBy,
          // Preserve existing completedAt if status is already 'done'; stamp it if newly done.
          completedAt: t.status === 'done' ? (t.completedAt ?? now) : undefined,
        }));
        setTasks(updated);
      },
    );

    // TTL sweep: remove completed tasks older than TASK_DONE_TTL_MS.
    const sweepId = setInterval(() => {
      const cutoff = Date.now() - TASK_DONE_TTL_MS;
      setTasks((prev) => prev.filter((t) => {
        if (t.status !== 'done') return true;
        return (t.completedAt ?? 0) > cutoff;
      }));
    }, TTL_SWEEP_INTERVAL_MS);

    return () => {
      dispose();
      clearInterval(sweepId);
    };
  }, []);

  return tasks;
}
