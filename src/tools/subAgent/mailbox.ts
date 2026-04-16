// mailbox.ts — SPEC-131 T1: in-memory ring buffer (256 msgs/agent) + JSONL persistence.
// Layer: tools. fsync batching: 100ms or 16 msgs, whichever first. ≤10 fsync/sec.
// Mailbox JSONL mode 0600. Heartbeats do NOT trigger fsync individually.

import { join } from 'node:path';
import { mkdir, open, chmod } from 'node:fs/promises';
import { z } from 'zod';
import { newToolUseId } from '../../ir/helpers.ts';
import { logger } from '../../observability/logger.ts';
import { workspacesDir } from '../../platform/paths.ts';

export type AgentId = string;

export const MailMessageTypeSchema = z.enum([
  'task_assignment',
  'task_result',
  'status_update',
  'error',
  'cancel',
  'heartbeat',
]);
export type MailMessageType = z.infer<typeof MailMessageTypeSchema>;

export const MailMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.union([z.string(), z.literal('*')]),
  type: MailMessageTypeSchema,
  payload: z.unknown(),
  timestamp: z.number(),
  trust: z.enum(['trusted', 'untrusted']),
  parentSpan: z.string().optional(),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;

export const RING_CAPACITY = 256;
const FSYNC_BATCH_SIZE = 16;
const FSYNC_INTERVAL_MS = 100;

export interface Mailbox {
  /** Enqueue a message into the ring buffer and schedule JSONL flush. */
  deliver(msg: Omit<MailMessage, 'id' | 'timestamp'>): MailMessage;
  /** Poll messages; optionally filter by sender / since timestamp / max count. */
  receive(opts?: { from?: AgentId; since?: number; limit?: number }): MailMessage[];
  /** Flush any pending JSONL writes immediately (useful in tests). */
  flush(): Promise<void>;
  /** Dispose the mailbox (flush + close). */
  dispose(): Promise<void>;
}

interface RingBuffer {
  msgs: MailMessage[];
  head: number; // index of next write slot
  count: number;
}

function ringPush(ring: RingBuffer, msg: MailMessage): void {
  ring.msgs[ring.head % RING_CAPACITY] = msg;
  ring.head = (ring.head + 1) % RING_CAPACITY;
  if (ring.count < RING_CAPACITY) ring.count++;
}

function ringMessages(ring: RingBuffer): MailMessage[] {
  if (ring.count < RING_CAPACITY) {
    return ring.msgs.slice(0, ring.count);
  }
  // Full ring: oldest first = head..end ++ 0..head
  const tail = ring.msgs.slice(ring.head);
  const front = ring.msgs.slice(0, ring.head);
  return [...tail, ...front];
}

export interface CreateMailboxOpts {
  workspaceId: string;
  agentId: AgentId;
  /** Override for testing — skip filesystem. */
  skipPersist?: boolean;
}

export function createMailbox(opts: CreateMailboxOpts): Mailbox {
  const ring: RingBuffer = { msgs: new Array(RING_CAPACITY), head: 0, count: 0 };
  const pending: MailMessage[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  let fileReady = false;
  const initPromise = opts.skipPersist ? Promise.resolve() : initFile();

  async function initFile(): Promise<void> {
    const dir = join(workspacesDir(), opts.workspaceId, 'mailbox');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${opts.agentId}.jsonl`);
    fileHandle = await open(path, 'a');
    await chmod(path, 0o600);
    fileReady = true;
  }

  function scheduleFlush(): void {
    if (disposed || opts.skipPersist) return;
    if (pending.length >= FSYNC_BATCH_SIZE) {
      // Batch full — flush immediately.
      void doFlush();
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void doFlush();
    }, FSYNC_INTERVAL_MS);
    if (typeof flushTimer === 'object' && flushTimer !== null && 'unref' in flushTimer) {
      (flushTimer as { unref(): void }).unref();
    }
  }

  async function doFlush(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    if (opts.skipPersist) return;
    await initPromise;
    if (!fileReady || fileHandle === null) {
      logger.warn({ agentId: opts.agentId }, 'mailbox file not ready, dropping batch');
      return;
    }
    const lines = batch.map((m) => JSON.stringify(m)).join('\n') + '\n';
    try {
      await fileHandle.write(lines);
      await fileHandle.datasync();
    } catch (err) {
      logger.warn({ err: (err as Error).message, agentId: opts.agentId }, 'mailbox fsync failed');
    }
  }

  function deliver(msg: Omit<MailMessage, 'id' | 'timestamp'>): MailMessage {
    const full: MailMessage = {
      ...msg,
      id: newToolUseId(),
      timestamp: Date.now(),
    };
    // Validate.
    MailMessageSchema.parse(full);
    ringPush(ring, full);
    // Heartbeats do NOT trigger fsync individually — but still enqueued to pending.
    if (full.type !== 'heartbeat') {
      pending.push(full);
      scheduleFlush();
    }
    return full;
  }

  function receive(opts2?: { from?: AgentId; since?: number; limit?: number }): MailMessage[] {
    let msgs = ringMessages(ring);
    if (opts2?.from !== undefined) {
      msgs = msgs.filter((m) => m.from === opts2.from);
    }
    if (opts2?.since !== undefined) {
      msgs = msgs.filter((m) => m.timestamp > opts2.since!);
    }
    if (opts2?.limit !== undefined) {
      msgs = msgs.slice(-opts2.limit);
    }
    return msgs;
  }

  async function flush(): Promise<void> {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await doFlush();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await doFlush();
    if (fileHandle !== null) {
      await fileHandle.close().catch(() => undefined);
      fileHandle = null;
    }
  }

  return { deliver, receive, flush, dispose };
}

/** Registry of agent mailboxes (per workspace). */
const mailboxRegistry = new Map<string, Mailbox>();

function registryKey(workspaceId: string, agentId: AgentId): string {
  return `${workspaceId}::${agentId}`;
}

export function getOrCreateMailbox(
  workspaceId: string,
  agentId: AgentId,
  skipPersist = false,
): Mailbox {
  const key = registryKey(workspaceId, agentId);
  let box = mailboxRegistry.get(key);
  if (!box) {
    box = createMailbox({ workspaceId, agentId, skipPersist });
    mailboxRegistry.set(key, box);
  }
  return box;
}

export function __clearMailboxRegistry(): void {
  mailboxRegistry.clear();
}
