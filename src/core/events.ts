// events.ts — SPEC-118 in-process event bus with per-subscriber bounded queue + drop-oldest.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { TOPICS, isRegisteredTopic } from './eventTypes.ts';

export type Disposable = () => void;

export interface Subscription {
  id: number;
  topic: string;
}

export interface EventBus {
  subscribe<T = unknown>(
    topic: string,
    cb: (event: T) => void | Promise<void>,
    opts?: { maxQueue?: number },
  ): Disposable;
  publish(topic: string, event: unknown): void;
  size(): { topics: number; subscribers: number };
}

export const DEFAULT_QUEUE_SIZE = 1000;
export const MAX_SUBSCRIBERS = 100;

interface Subscriber {
  id: number;
  topic: string;
  cb: (event: unknown) => void | Promise<void>;
  queue: unknown[];
  maxQueue: number;
  draining: boolean;
  droppedSinceLastReport: number;
}

export function createEventBus(): EventBus {
  const topics = new Map<string, Set<Subscriber>>();
  let nextId = 1;
  let totalSubs = 0;

  function drainQueue(sub: Subscriber): void {
    if (sub.draining) return;
    sub.draining = true;
    queueMicrotask(async () => {
      while (sub.queue.length > 0) {
        const event = sub.queue.shift();
        try {
          await sub.cb(event);
        } catch (err) {
          // Emit subscriber error to bus (best-effort; don't loop forever on self-error).
          if (sub.topic !== TOPICS.bus.subscriberError) {
            publish(TOPICS.bus.subscriberError, {
              type: TOPICS.bus.subscriberError,
              topic: sub.topic,
              subscriberId: sub.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      sub.draining = false;
    });
  }

  function publish(topic: string, event: unknown): void {
    if (!isRegisteredTopic(topic)) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'unregistered_topic',
        topic,
      });
    }
    const subs = topics.get(topic);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      if (sub.queue.length >= sub.maxQueue) {
        sub.queue.shift();
        sub.droppedSinceLastReport += 1;
        if (topic !== TOPICS.bus.overflow) {
          const droppedCount = sub.droppedSinceLastReport;
          sub.droppedSinceLastReport = 0;
          // Publish overflow event asynchronously to avoid re-entering the same sub.
          queueMicrotask(() => {
            try {
              publish(TOPICS.bus.overflow, {
                type: TOPICS.bus.overflow,
                topic: sub.topic,
                subscriberId: sub.id,
                droppedCount,
              });
            } catch {
              // swallow — overflow publication must not fail the producer.
            }
          });
        }
      }
      sub.queue.push(event);
      drainQueue(sub);
    }
  }

  function subscribe<T = unknown>(
    topic: string,
    cb: (event: T) => void | Promise<void>,
    opts?: { maxQueue?: number },
  ): Disposable {
    if (!isRegisteredTopic(topic)) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'unregistered_topic',
        topic,
      });
    }
    if (totalSubs >= MAX_SUBSCRIBERS) {
      throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
        reason: 'max_subscribers',
        limit: MAX_SUBSCRIBERS,
      });
    }
    const id = nextId++;
    const sub: Subscriber = {
      id,
      topic,
      cb: cb as (event: unknown) => void | Promise<void>,
      queue: [],
      maxQueue: Math.max(1, opts?.maxQueue ?? DEFAULT_QUEUE_SIZE),
      draining: false,
      droppedSinceLastReport: 0,
    };
    let set = topics.get(topic);
    if (!set) {
      set = new Set();
      topics.set(topic, set);
    }
    set.add(sub);
    totalSubs += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      // Drain any queued events synchronously (deliver via microtask still) before removing.
      if (sub.queue.length > 0 && !sub.draining) {
        drainQueue(sub);
      }
      const s = topics.get(topic);
      if (s) {
        s.delete(sub);
        if (s.size === 0) topics.delete(topic);
      }
      totalSubs = Math.max(0, totalSubs - 1);
    };
  }

  function size(): { topics: number; subscribers: number } {
    return { topics: topics.size, subscribers: totalSubs };
  }

  return { publish, subscribe, size };
}

let globalBus: EventBus | null = null;

export function getGlobalBus(): EventBus {
  if (!globalBus) globalBus = createEventBus();
  return globalBus;
}

export function __resetGlobalBus(): void {
  globalBus = null;
}
