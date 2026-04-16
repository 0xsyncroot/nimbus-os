import { describe, test, expect, beforeEach } from 'bun:test';
import { createChannelManager } from '../../src/channels/ChannelManager.ts';
import { createEventBus } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import type { ChannelInboundEvent } from '../../src/core/eventTypes.ts';
import type { ChannelAdapter } from '../../src/channels/ChannelAdapter.ts';
import { NimbusError } from '../../src/observability/errors.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

interface TrackingAdapter extends ChannelAdapter {
  startCalls: number;
  stopCalls: number;
  sendCalls: Array<{ workspaceId: string; text: string }>;
}

function makeAdapter(id: string, overrides?: Partial<ChannelAdapter>): TrackingAdapter {
  const adapter: TrackingAdapter = {
    id,
    kind: 'http' as const,
    nativeFormat: 'markdown' as const,
    capabilities: { nativeFormat: 'markdown' as const },
    startCalls: 0,
    stopCalls: 0,
    sendCalls: [],
    async start() { adapter.startCalls++; },
    async stop() { adapter.stopCalls++; },
    async send(workspaceId: string, text: string) {
      adapter.sendCalls.push({ workspaceId, text });
    },
  };
  if (overrides) Object.assign(adapter, overrides);
  return adapter;
}

// ── SPEC-802: ChannelManager ──────────────────────────────────────────────────

describe('SPEC-802: ChannelManager', () => {
  let bus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    bus = createEventBus();
  });

  test('register + startAll → adapter.start() called', async () => {
    const mgr = createChannelManager(bus);
    const adapter = makeAdapter('test-1');
    mgr.register(adapter);
    await mgr.startAll();
    expect(adapter.startCalls).toBe(1);
  });

  test('stopAll → adapter.stop() called', async () => {
    const mgr = createChannelManager(bus);
    const adapter = makeAdapter('test-2');
    mgr.register(adapter);
    await mgr.startAll();
    await mgr.stopAll();
    expect(adapter.stopCalls).toBe(1);
  });

  test('startAll is idempotent — second call does not double-start', async () => {
    const mgr = createChannelManager(bus);
    const adapter = makeAdapter('test-3');
    mgr.register(adapter);
    await mgr.startAll();
    await mgr.startAll();
    expect(adapter.startCalls).toBe(1);
  });

  test('publishInbound → EventBus receives channel.inbound with correct shape', async () => {
    const mgr = createChannelManager(bus);
    const received: ChannelInboundEvent[] = [];
    bus.subscribe<ChannelInboundEvent>(TOPICS.channel.inbound, (ev) => {
      received.push(ev);
    });

    mgr.publishInbound({
      adapterId: 'http',
      workspaceId: 'ws-001',
      userId: 'user-1',
      text: 'hello world',
      raw: { original: true },
    });

    // microtask flush
    await new Promise<void>((r) => queueMicrotask(r));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('channel.inbound');
    expect(received[0]?.adapterId).toBe('http');
    expect(received[0]?.workspaceId).toBe('ws-001');
    expect(received[0]?.text).toBe('hello world');
  });

  test('publishInbound rejects empty workspaceId', () => {
    const mgr = createChannelManager(bus);
    expect(() =>
      mgr.publishInbound({
        adapterId: 'http',
        workspaceId: '',
        userId: 'u',
        text: 'hi',
        raw: null,
      }),
    ).toThrow(NimbusError);
  });

  test('duplicate adapter id throws', () => {
    const mgr = createChannelManager(bus);
    mgr.register(makeAdapter('dup'));
    expect(() => mgr.register(makeAdapter('dup'))).toThrow(NimbusError);
  });

  test('multiple adapters — all started', async () => {
    const mgr = createChannelManager(bus);
    const a = makeAdapter('a');
    const b = makeAdapter('b');
    mgr.register(a);
    mgr.register(b);
    await mgr.startAll();
    expect(a.startCalls).toBe(1);
    expect(b.startCalls).toBe(1);
  });

  test('startAll throws when an adapter fails to start', async () => {
    const mgr = createChannelManager(bus);
    const broken = makeAdapter('broken', {
      async start() { throw new Error('start failed'); },
    });
    mgr.register(broken);
    await expect(mgr.startAll()).rejects.toThrow(NimbusError);
  });
});
