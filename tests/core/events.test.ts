import { describe, expect, test } from 'bun:test';
import { createEventBus, DEFAULT_QUEUE_SIZE, MAX_SUBSCRIBERS } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SPEC-118: event bus', () => {
  test('subscribe + publish delivers event', async () => {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(TOPICS.session.userMsg, (ev) => {
      received.push(ev);
    });
    bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: 'hi', ts: 1 });
    await tick();
    expect(received.length).toBe(1);
  });

  test('multiple subscribers same topic all receive', async () => {
    const bus = createEventBus();
    let a = 0, b = 0;
    bus.subscribe(TOPICS.session.userMsg, () => { a++; });
    bus.subscribe(TOPICS.session.userMsg, () => { b++; });
    bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: 'hi', ts: 1 });
    await tick();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test('subscribers across topics isolated', async () => {
    const bus = createEventBus();
    let u = 0, t = 0;
    bus.subscribe(TOPICS.session.userMsg, () => { u++; });
    bus.subscribe(TOPICS.tool.start, () => { t++; });
    bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: 'x', ts: 1 });
    await tick();
    expect(u).toBe(1);
    expect(t).toBe(0);
  });

  test('dispose removes subscriber', async () => {
    const bus = createEventBus();
    let cnt = 0;
    const d = bus.subscribe(TOPICS.session.userMsg, () => { cnt++; });
    d();
    bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: 'x', ts: 1 });
    await tick();
    expect(cnt).toBe(0);
  });

  test('overflow drops oldest + emits bus.overflow', async () => {
    const bus = createEventBus();
    const cap = 10;
    const overflows: unknown[] = [];
    bus.subscribe(TOPICS.bus.overflow, (ev) => {
      overflows.push(ev);
    });
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    bus.subscribe(
      TOPICS.session.userMsg,
      async () => {
        await slow;
      },
      { maxQueue: cap },
    );
    for (let i = 0; i < cap + 5; i++) {
      bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: String(i), ts: i });
    }
    release();
    await tick();
    await tick();
    expect(overflows.length).toBeGreaterThan(0);
  });

  test('unregistered topic throws U_BAD_COMMAND', () => {
    const bus = createEventBus();
    try {
      bus.publish('nope.topic', {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });

  test('max subscribers enforced', () => {
    const bus = createEventBus();
    for (let i = 0; i < MAX_SUBSCRIBERS; i++) {
      bus.subscribe(TOPICS.session.userMsg, () => undefined);
    }
    try {
      bus.subscribe(TOPICS.session.userMsg, () => undefined);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NimbusError);
      expect((err as NimbusError).code).toBe(ErrorCode.U_BAD_COMMAND);
    }
  });

  test('microtask delivery — publish returns before callback', async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.subscribe(TOPICS.session.userMsg, () => {
      order.push('cb');
    });
    bus.publish(TOPICS.session.userMsg, { type: TOPICS.session.userMsg, sessionId: 'X', text: 'x', ts: 1 });
    order.push('after_publish');
    await tick();
    expect(order[0]).toBe('after_publish');
    expect(order[1]).toBe('cb');
  });

  test('DEFAULT_QUEUE_SIZE is 1000', () => {
    expect(DEFAULT_QUEUE_SIZE).toBe(1000);
  });
});
