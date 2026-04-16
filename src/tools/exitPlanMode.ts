// exitPlanMode.ts — SPEC-133: ExitPlanMode tool.
// Takes {plan: string}, emits plan.proposed event, blocks until plan.decision received.
// SYNC within the tool cycle — does not return until user decides.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { getGlobalBus } from '../core/events.ts';
import { TOPICS } from '../core/eventTypes.ts';
import type { PlanDecisionEvent } from '../core/eventTypes.ts';
import type { Tool } from './types.ts';

export const ExitPlanModeInputSchema = z.object({
  plan: z.string().min(1).max(8000),
}).strict();
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;

export interface ExitPlanModeOutput {
  decision: 'approve' | 'reject' | 'refine';
  refineHint?: string;
  targetMode?: 'default' | 'acceptEdits';
  plan: string;
}

/** Timeout for awaiting a plan decision (user-driven; currently no hard limit in v0.3.1). */
const DECISION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes soft timeout

export function createExitPlanModeTool(): Tool<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: 'ExitPlanMode',
    description:
      'Propose a plan to the user and wait for approval, rejection, or refinement request. ' +
      'Plan mode only. Blocks the tool cycle until the user decides. ' +
      'plan param max 8000 chars.',
    readOnly: false,
    inputSchema: ExitPlanModeInputSchema,
    async handler(input, ctx) {
      if (ctx.mode !== 'plan') {
        return {
          ok: false,
          error: new NimbusError(ErrorCode.T_PERMISSION, {
            tool: 'ExitPlanMode',
            reason: 'not_in_plan_mode',
            hint: 'ExitPlanMode can only be called while in plan mode',
            currentMode: ctx.mode,
          }),
        };
      }

      const bus = getGlobalBus();
      const turnId = ctx.turnId;

      // Emit plan.proposed — channel/REPL renders this to the user.
      bus.publish(TOPICS.plan.proposed, {
        type: TOPICS.plan.proposed,
        plan: input.plan,
        turnId,
        sessionId: ctx.sessionId,
        ts: Date.now(),
      });

      // Block until plan.decision event arrives (emitted by channel/REPL after user input).
      const decision = await awaitDecision(bus, DECISION_TIMEOUT_MS, ctx.signal);

      if (!decision) {
        // Timeout or abort — treat as reject to keep agent in plan mode.
        return {
          ok: false,
          error: new NimbusError(ErrorCode.T_TIMEOUT, {
            tool: 'ExitPlanMode',
            reason: 'decision_timeout',
            hint: 'User did not decide within the timeout; staying in plan mode',
          }),
        };
      }

      const resultText = formatDecisionText(decision, input.plan);
      return {
        ok: true,
        output: {
          decision: decision.decision,
          refineHint: decision.refineHint,
          targetMode: decision.targetMode,
          plan: input.plan,
        },
        display: resultText,
      };
    },
  };
}

/**
 * Wait for a single plan.decision event on the event bus.
 * Returns the event or null on timeout/abort.
 */
async function awaitDecision(
  bus: ReturnType<typeof getGlobalBus>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PlanDecisionEvent | null> {
  return new Promise<PlanDecisionEvent | null>((resolve) => {
    let settled = false;

    const settle = (val: PlanDecisionEvent | null): void => {
      if (settled) return;
      settled = true;
      dispose();
      clearTimeout(timer);
      resolve(val);
    };

    const dispose = bus.subscribe<PlanDecisionEvent>(
      TOPICS.plan.decision,
      (event) => {
        settle(event);
      },
      { maxQueue: 1 },
    );

    const timer = setTimeout(() => settle(null), timeoutMs);

    if (signal.aborted) {
      settle(null);
      return;
    }
    signal.addEventListener('abort', () => settle(null), { once: true });
  });
}

function formatDecisionText(
  decision: PlanDecisionEvent,
  plan: string,
): string {
  switch (decision.decision) {
    case 'approve':
      return [
        'Plan approved. You can now start implementing.',
        '',
        '## Approved Plan:',
        plan,
      ].join('\n');
    case 'reject':
      return 'Plan rejected. Staying in plan mode. Revise your approach and call ExitPlanMode again.';
    case 'refine':
      return [
        'Plan needs refinement.',
        decision.refineHint ? `Feedback: ${decision.refineHint}` : '',
        'Revise your plan and call ExitPlanMode again.',
      ].filter(Boolean).join('\n');
    default:
      return 'Unknown decision.';
  }
}
