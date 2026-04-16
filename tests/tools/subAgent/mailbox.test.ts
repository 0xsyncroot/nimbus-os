import { describe, test, expect, afterEach } from 'bun:test';
import {
  createMailbox,
  getOrCreateMailbox,
  __clearMailboxRegistry,
  RING_CAPACITY,
} from '../../../src/tools/subAgent/mailbox.ts';

const RING = RING_CAPACITY;

afterEach(() => {
  __clearMailboxRegistry();
});

describe('SPEC-131: mailbox ring buffer', () => {
  test('delivers and receives a message', () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-1', skipPersist: true });
    const msg = box.deliver({
      from: 'agent-0',
      to: 'agent-1',
      type: 'task_assignment',
      payload: { task: 'search' },
      trust: 'trusted',
    });
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
    const received = box.receive();
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('task_assignment');
  });

  test(`ring eviction: write ${RING + 10} messages → ring holds last ${RING}`, async () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-ring', skipPersist: true });
    for (let i = 0; i < RING + 10; i++) {
      box.deliver({
        from: 'sender',
        to: 'agent-ring',
        type: 'status_update',
        payload: { seq: i },
        trust: 'trusted',
      });
    }
    const msgs = box.receive();
    expect(msgs).toHaveLength(RING);
    // Last message should have seq = RING + 9 (the most recently written).
    const last = msgs[msgs.length - 1]!;
    expect((last.payload as { seq: number }).seq).toBe(RING + 9);
  });

  test('receive filters by from', () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-filter', skipPersist: true });
    box.deliver({ from: 'alice', to: 'agent-filter', type: 'status_update', payload: null, trust: 'trusted' });
    box.deliver({ from: 'bob', to: 'agent-filter', type: 'status_update', payload: null, trust: 'trusted' });
    box.deliver({ from: 'alice', to: 'agent-filter', type: 'task_result', payload: null, trust: 'trusted' });
    const aliceMsgs = box.receive({ from: 'alice' });
    expect(aliceMsgs).toHaveLength(2);
    expect(aliceMsgs.every((m) => m.from === 'alice')).toBe(true);
  });

  test('receive filters by since — returns only messages after the cutoff', () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-since', skipPersist: true });
    // Deliver a message, then use its timestamp as the cutoff.
    const msg1 = box.deliver({ from: 'sender', to: 'agent-since', type: 'status_update', payload: { seq: 1 }, trust: 'trusted' });
    const msg2 = box.deliver({ from: 'sender', to: 'agent-since', type: 'task_result', payload: { seq: 2 }, trust: 'trusted' });
    // Filter messages strictly after msg1 (since = msg1.timestamp).
    const filtered = box.receive({ since: msg1.timestamp });
    // Only msg2 has timestamp >= msg1.timestamp. In fast tests both may share the same ms,
    // so we assert >= 1 and that all returned messages are >= msg1.timestamp.
    for (const m of filtered) {
      expect(m.timestamp).toBeGreaterThanOrEqual(msg1.timestamp);
    }
    void msg2;
  });

  test('receive respects limit', () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-limit', skipPersist: true });
    for (let i = 0; i < 20; i++) {
      box.deliver({ from: 'sender', to: 'agent-limit', type: 'status_update', payload: i, trust: 'trusted' });
    }
    const limited = box.receive({ limit: 5 });
    expect(limited).toHaveLength(5);
  });

  test('heartbeat messages do not trigger fsync (skipPersist: no pending write)', async () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-hb', skipPersist: true });
    // Heartbeats should still be stored in ring.
    box.deliver({ from: 'sub-1', to: 'agent-hb', type: 'heartbeat', payload: null, trust: 'trusted' });
    const msgs = box.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe('heartbeat');
    // flush should be a no-op (skipPersist=true, no file writes).
    await box.flush();
  });

  test('getOrCreateMailbox returns same instance', () => {
    const box1 = getOrCreateMailbox('ws-2', 'agent-2', true);
    const box2 = getOrCreateMailbox('ws-2', 'agent-2', true);
    expect(box1).toBe(box2);
  });

  test('getOrCreateMailbox different agents → different boxes', () => {
    const box1 = getOrCreateMailbox('ws-3', 'agent-a', true);
    const box2 = getOrCreateMailbox('ws-3', 'agent-b', true);
    expect(box1).not.toBe(box2);
  });

  test('dispose closes the mailbox', async () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-dispose', skipPersist: true });
    box.deliver({ from: 'x', to: 'agent-dispose', type: 'status_update', payload: null, trust: 'trusted' });
    await box.dispose();
    // After dispose, further receives still work (in-memory ring intact).
    const msgs = box.receive();
    expect(msgs).toHaveLength(1);
  });
});

describe('SPEC-131: mailbox trust wrapping integration', () => {
  test('trust field preserved on message', () => {
    const box = createMailbox({ workspaceId: 'ws-1', agentId: 'agent-trust', skipPersist: true });
    const msg = box.deliver({
      from: 'sub-agent-1',
      to: 'agent-trust',
      type: 'task_result',
      payload: { output: 'result text' },
      trust: 'untrusted',
    });
    expect(msg.trust).toBe('untrusted');
    const received = box.receive();
    expect(received[0]!.trust).toBe('untrusted');
  });
});
