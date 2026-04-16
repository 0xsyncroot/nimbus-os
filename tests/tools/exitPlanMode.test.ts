// tests/tools/exitPlanMode.test.ts — SPEC-133 §6.1 ExitPlanMode tool tests.

import { describe, expect, test, beforeEach } from 'bun:test';
import { z } from 'zod';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';
import { createExitPlanModeTool } from '../../src/tools/exitPlanMode.ts';
import { createEnterPlanModeTool } from '../../src/tools/enterPlanMode.ts';
import { __resetGlobalBus, getGlobalBus } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import type { Gate } from '../../src/permissions/gate.ts';

function makeCtx(mode: ToolContext['mode'] = 'plan'): ToolContext {
  const ctrl = new AbortController();
  return {
    workspaceId: 'W1',
    sessionId: 'S1',
    turnId: 'T1',
    toolUseId: 'TU1',
    cwd: '/tmp/project',
    signal: ctrl.signal,
    onAbort: () => { /* noop */ },
    mode,
    permissions: {
      async canUseTool() { return 'allow' as const; },
      rememberAllow() { /* noop */ },
      forgetSession() { /* noop */ },
    } satisfies Gate,
    logger: {} as unknown as ToolContext['logger'],
  };
}

beforeEach(() => {
  __resetGlobalBus();
});

// ─── EnterPlanMode ───────────────────────────────────────────────────────────

describe('SPEC-133: EnterPlanMode tool', () => {
  test('returns ACK when entering plan mode from default', async () => {
    const tool = createEnterPlanModeTool();
    const result = await tool.handler({}, makeCtx('default'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.message).toContain('Entered plan mode');
      expect(result.output.previousMode).toBe('default');
    }
  });

  test('returns idempotent ACK when already in plan mode', async () => {
    const tool = createEnterPlanModeTool();
    const result = await tool.handler({}, makeCtx('plan'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.message).toContain('Already in plan mode');
    }
  });

  test('has readOnly: true', () => {
    const tool = createEnterPlanModeTool();
    expect(tool.readOnly).toBe(true);
  });

  test('accepts empty input (strict schema)', () => {
    const tool = createEnterPlanModeTool();
    const parsed = tool.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  test('rejects extra input fields (strict schema)', () => {
    const tool = createEnterPlanModeTool();
    const parsed = tool.inputSchema.safeParse({ unexpected: 'field' });
    expect(parsed.success).toBe(false);
  });
});

// ─── ExitPlanMode — input validation ─────────────────────────────────────────

describe('SPEC-133: ExitPlanMode — input schema', () => {
  test('accepts valid plan string', () => {
    const tool = createExitPlanModeTool();
    const parsed = tool.inputSchema.safeParse({ plan: 'Step 1: read the code.' });
    expect(parsed.success).toBe(true);
  });

  test('rejects empty plan string', () => {
    const tool = createExitPlanModeTool();
    const parsed = tool.inputSchema.safeParse({ plan: '' });
    expect(parsed.success).toBe(false);
  });

  test('rejects plan string > 8000 chars', () => {
    const tool = createExitPlanModeTool();
    const big = 'a'.repeat(8001);
    const parsed = tool.inputSchema.safeParse({ plan: big });
    expect(parsed.success).toBe(false);
  });

  test('accepts plan string of exactly 8000 chars', () => {
    const tool = createExitPlanModeTool();
    const ok = 'a'.repeat(8000);
    const parsed = tool.inputSchema.safeParse({ plan: ok });
    expect(parsed.success).toBe(true);
  });
});

// ─── ExitPlanMode — mode guard ────────────────────────────────────────────────

describe('SPEC-133: ExitPlanMode — not in plan mode', () => {
  test('returns error result when called from default mode', async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.handler({ plan: 'my plan' }, makeCtx('default'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.T_PERMISSION);
      expect(result.error.context['reason']).toBe('not_in_plan_mode');
    }
  });
});

// ─── ExitPlanMode — plan.proposed event ──────────────────────────────────────

describe('SPEC-133: ExitPlanMode — plan.proposed event', () => {
  test('emits plan.proposed with correct payload before blocking', async () => {
    const tool = createExitPlanModeTool();
    const bus = getGlobalBus();

    const proposedEvents: unknown[] = [];
    bus.subscribe(TOPICS.plan.proposed, (e) => { proposedEvents.push(e); });

    // Schedule approval immediately so the tool does not block long.
    setTimeout(() => {
      bus.publish(TOPICS.plan.decision, {
        type: TOPICS.plan.decision,
        decision: 'approve',
      });
    }, 5);

    const result = await tool.handler({ plan: 'Step 1: do the thing.' }, makeCtx('plan'));
    await new Promise((r) => setTimeout(r, 10));

    expect(proposedEvents.length).toBe(1);
    const ev = proposedEvents[0] as { type: string; plan: string; turnId: string };
    expect(ev.type).toBe(TOPICS.plan.proposed);
    expect(ev.plan).toBe('Step 1: do the thing.');
    expect(ev.turnId).toBe('T1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.decision).toBe('approve');
    }
  });
});

// ─── ExitPlanMode — decision branches ────────────────────────────────────────

describe('SPEC-133: ExitPlanMode — decision branches', () => {
  test('approve → ok result + plan echoed', async () => {
    const tool = createExitPlanModeTool();
    const bus = getGlobalBus();

    setTimeout(() => {
      bus.publish(TOPICS.plan.decision, {
        type: TOPICS.plan.decision,
        decision: 'approve',
        targetMode: 'default',
      });
    }, 5);

    const result = await tool.handler({ plan: 'Plan A' }, makeCtx('plan'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.decision).toBe('approve');
      expect(result.output.plan).toBe('Plan A');
      expect(result.output.targetMode).toBe('default');
      expect(result.display).toContain('Approved Plan');
    }
  });

  test('reject → ok result with reject decision', async () => {
    const tool = createExitPlanModeTool();
    const bus = getGlobalBus();

    setTimeout(() => {
      bus.publish(TOPICS.plan.decision, {
        type: TOPICS.plan.decision,
        decision: 'reject',
      });
    }, 5);

    const result = await tool.handler({ plan: 'Plan B' }, makeCtx('plan'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.decision).toBe('reject');
      expect(result.display).toContain('rejected');
    }
  });

  test('refine → ok result with refineHint', async () => {
    const tool = createExitPlanModeTool();
    const bus = getGlobalBus();

    setTimeout(() => {
      bus.publish(TOPICS.plan.decision, {
        type: TOPICS.plan.decision,
        decision: 'refine',
        refineHint: 'Add error handling step',
      });
    }, 5);

    const result = await tool.handler({ plan: 'Plan C' }, makeCtx('plan'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.decision).toBe('refine');
      expect(result.output.refineHint).toBe('Add error handling step');
      expect(result.display).toContain('refinement');
    }
  });

  test('abort signal → T_TIMEOUT error result', async () => {
    const tool = createExitPlanModeTool();
    const ctrl = new AbortController();

    const ctxWithAbort = makeCtx('plan');
    (ctxWithAbort as { signal: AbortSignal }).signal = ctrl.signal;

    // Abort immediately.
    ctrl.abort();

    const result = await tool.handler({ plan: 'Plan D' }, ctxWithAbort);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.T_TIMEOUT);
    }
  });
});
