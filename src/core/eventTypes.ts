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
  channel: {
    inbound: 'channel.inbound',
  },
  security: {
    event: 'security.event',
  },
  shell: {
    stdoutLine: 'shell.stdout_line',
    stderrLine: 'shell.stderr_line',
    exit: 'shell.exit',
    bufferOverflow: 'shell.buffer_overflow',
  },
  plan: {
    proposed: 'plan.proposed',
    decision: 'plan.decision',
  },
  tools: {
    todoUpdate: 'tools.todoUpdate',
  },
  ui: {
    error: 'ui.error',
    assistantDelta: 'ui.assistantDelta',
    assistantComplete: 'ui.assistantComplete',
    turnStart: 'ui.turnStart',
    turnComplete: 'ui.turnComplete',
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

export type ChannelInboundEvent = {
  type: 'channel.inbound';
  adapterId: string;
  workspaceId: string;
  userId: string;
  text: string;
  /** Adapter-specific native event — opaque to core. */
  raw: unknown;
};

export type SecurityEvent = {
  type: 'security.event';
  adapterId: string;
  reason: string;
  /** User identifier — never includes message content (privacy). */
  userId: string | number;
  ts: number;
};

export type ShellEvent =
  | { type: 'shell.stdout_line'; taskId: string; line: string; ts: number }
  | { type: 'shell.stderr_line'; taskId: string; line: string; ts: number }
  | { type: 'shell.exit'; taskId: string; exitCode: number; ts: number }
  | { type: 'shell.buffer_overflow'; taskId: string; droppedLines: number };

/** SPEC-848: TodoUpdate event — emitted when agent writes task list. */
export type TodoUpdateEvent = {
  type: 'tools.todoUpdate';
  tasks: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'done';
    owner?: string;
    blockedBy?: string[];
    completedAt?: number;
  }>;
  ts: number;
};

/** SPEC-852: ui.error event — emitted by render.ts / slashCommands.ts; consumed by Ink REPL (SPEC-851). */
export type UiErrorEvent = {
  type: 'ui.error';
  error: import('../observability/errors.ts').NimbusError;
  ts: number;
};

/** v0.4.0.2 streaming wire: published by repl.ts handleSubmit, consumed by Ink <AssistantMessage>. */
export type UiAssistantDeltaEvent = {
  type: 'ui.assistantDelta';
  turnId: string;
  blockId: string;
  text: string;
  ts: number;
};
export type UiAssistantCompleteEvent = {
  type: 'ui.assistantComplete';
  turnId: string;
  blockId: string;
  text: string;
  ts: number;
};
export type UiTurnStartEvent = {
  type: 'ui.turnStart';
  turnId: string;
  ts: number;
};
export type UiTurnCompleteEvent = {
  type: 'ui.turnComplete';
  turnId: string;
  outcome: 'success' | 'error';
  errorCode?: string;
  ts: number;
};

/** SPEC-133: plan mode events — emitted by ExitPlanMode tool. */
export type PlanProposedEvent = {
  type: 'plan.proposed';
  plan: string;
  turnId: string;
  sessionId: string;
  ts: number;
};

export type PlanDecisionEvent = {
  type: 'plan.decision';
  decision: 'approve' | 'reject' | 'refine';
  refineHint?: string;
  targetMode?: 'default' | 'acceptEdits';
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
  TOPICS.channel.inbound,
  TOPICS.security.event,
  TOPICS.shell.stdoutLine,
  TOPICS.shell.stderrLine,
  TOPICS.shell.exit,
  TOPICS.shell.bufferOverflow,
  TOPICS.plan.proposed,
  TOPICS.plan.decision,
  TOPICS.tools.todoUpdate,
  TOPICS.ui.error,
  TOPICS.ui.assistantDelta,
  TOPICS.ui.assistantComplete,
  TOPICS.ui.turnStart,
  TOPICS.ui.turnComplete,
]);

export function isRegisteredTopic(topic: string): boolean {
  return REGISTERED.has(topic);
}
