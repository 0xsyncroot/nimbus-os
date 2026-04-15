// eventTypes.ts — SPEC-118 event bus contract: frozen topic namespace + event unions.

export const TOPICS = Object.freeze({
  session: {
    userMsg: 'session.user_msg',
    assistantMsg: 'session.assistant_msg',
    toolUse: 'session.tool_use',
    toolResult: 'session.tool_result',
    turnComplete: 'session.turn_complete',
    error: 'session.error',
    planAnnounce: 'session.plan_announce',
    specGenerated: 'session.spec_generated',
    usage: 'session.usage',
  },
  tool: {
    start: 'tool.start',
    end: 'tool.end',
  },
  breaker: {
    opened: 'breaker.opened',
    closed: 'breaker.closed',
    probe: 'breaker.probe',
  },
  bus: {
    overflow: 'bus.overflow',
    subscriberError: 'bus.subscriber_error',
  },
} as const);

export type SessionEvent =
  | { type: 'session.user_msg'; sessionId: string; text: string; ts: number }
  | { type: 'session.assistant_msg'; sessionId: string; turnId: string; text: string; ts: number }
  | { type: 'session.tool_use'; sessionId: string; turnId: string; toolUseId: string; name: string; input: unknown; ts: number }
  | { type: 'session.tool_result'; sessionId: string; turnId: string; toolUseId: string; name: string; ok: boolean; ms: number; ts: number }
  | { type: 'session.turn_complete'; sessionId: string; turnId: string; ok: boolean; ms: number }
  | { type: 'session.error'; sessionId: string; code: string; ts: number }
  | { type: 'session.plan_announce'; sessionId: string; turnId: string; reason: string; heuristic: string; ts: number }
  | { type: 'session.spec_generated'; sessionId: string; turnId: string; summary: string; ts: number }
  | {
      type: 'session.usage';
      sessionId: string;
      turnId: string;
      model: string;
      provider: string;
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      ts: number;
    };

export type ToolEvent =
  | { type: 'tool.start'; toolUseId: string; name: string; ts: number }
  | { type: 'tool.end'; toolUseId: string; ok: boolean; ms: number; ts: number };

export type BusOverflowEvent = {
  type: 'bus.overflow';
  topic: string;
  subscriberId: number;
  droppedCount: number;
};

export type BusSubscriberErrorEvent = {
  type: 'bus.subscriber_error';
  topic: string;
  subscriberId: number;
  error: string;
};

const REGISTERED: ReadonlySet<string> = new Set<string>([
  TOPICS.session.userMsg,
  TOPICS.session.assistantMsg,
  TOPICS.session.toolUse,
  TOPICS.session.toolResult,
  TOPICS.session.turnComplete,
  TOPICS.session.error,
  TOPICS.session.planAnnounce,
  TOPICS.session.specGenerated,
  TOPICS.session.usage,
  TOPICS.tool.start,
  TOPICS.tool.end,
  TOPICS.breaker.opened,
  TOPICS.breaker.closed,
  TOPICS.breaker.probe,
  TOPICS.bus.overflow,
  TOPICS.bus.subscriberError,
]);

export function isRegisteredTopic(topic: string): boolean {
  return REGISTERED.has(topic);
}
