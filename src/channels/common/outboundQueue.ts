// outboundQueue.ts — SPEC-802 T3: async FIFO queue with bounded capacity.
// maxSize=500 drop-oldest; maxConcurrency=1 per adapter.
// Uses only Bun-native async primitives — no p-queue dependency.

export interface OutboundQueue {
  /** Enqueue a task. Returns immediately (<1ms). Drops oldest if at capacity. */
  enqueue(task: () => Promise<void>): void;
  /** Resolve when all currently-queued tasks have been executed. */
  drain(): Promise<void>;
}

export interface OutboundQueueOpts {
  maxSize?: number;
  maxConcurrency?: number;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_CONCURRENCY = 1;

export function createOutboundQueue(opts?: OutboundQueueOpts): OutboundQueue {
  const maxSize = Math.max(1, opts?.maxSize ?? DEFAULT_MAX_SIZE);
  const maxConcurrency = Math.max(1, opts?.maxConcurrency ?? DEFAULT_CONCURRENCY);

  const queue: Array<() => Promise<void>> = [];
  let running = 0;
  // Drain waiters: resolve callbacks waiting on drain()
  const drainWaiters: Array<() => void> = [];

  function notifyDrainWaiters(): void {
    if (running === 0 && queue.length === 0) {
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  function scheduleNext(): void {
    while (running < maxConcurrency && queue.length > 0) {
      const task = queue.shift()!;
      running++;
      Promise.resolve()
        .then(() => task())
        .catch(() => {
          // Swallow task errors — adapter is responsible for its own error handling.
        })
        .finally(() => {
          running--;
          scheduleNext();
          notifyDrainWaiters();
        });
    }
    notifyDrainWaiters();
  }

  function enqueue(task: () => Promise<void>): void {
    if (queue.length >= maxSize) {
      // Drop-oldest policy: remove head to make room.
      queue.shift();
    }
    queue.push(task);
    scheduleNext();
  }

  function drain(): Promise<void> {
    if (running === 0 && queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  return { enqueue, drain };
}
