// enterPlanMode.ts — SPEC-133: EnterPlanMode tool.
// Idempotent; transitions agent mode to 'plan'; returns ACK string.

import { z } from 'zod';
import type { Tool } from './types.ts';

const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export interface EnterPlanModeOutput {
  message: string;
  previousMode: string;
}

const ACK_TEXT = [
  'Entered plan mode. You should now focus on exploring the codebase and designing',
  'an implementation approach.',
  '',
  'In plan mode:',
  '- Read, Grep, Glob, and TodoWrite are allowed',
  '- Write, Edit, Bash, and all destructive tools are BLOCKED',
  '- When ready, call ExitPlanMode({plan: "..."}) to propose your plan',
  '',
  'Remember: do NOT write or edit any files yet. This is a read-only exploration phase.',
].join('\n');

export function createEnterPlanModeTool(): Tool<EnterPlanModeInput, EnterPlanModeOutput> {
  return {
    name: 'EnterPlanMode',
    description:
      'Switch agent to plan mode — read-only exploration phase. ' +
      'Write/Edit/Bash blocked until ExitPlanMode approves the plan.',
    readOnly: true,
    inputSchema: EnterPlanModeInputSchema,
    async handler(_input, ctx) {
      const previousMode = ctx.mode;

      // Idempotent: already in plan mode is fine.
      if (previousMode === 'plan') {
        return {
          ok: true,
          output: {
            message: 'Already in plan mode.',
            previousMode,
          },
          display: 'Already in plan mode.',
        };
      }

      // Note: mode transition is enforced at the executor/gate layer (SPEC-133).
      // The tool itself only returns an ACK; the caller (CLI/REPL) is responsible
      // for updating the TurnContext.mode to 'plan' after this tool succeeds.
      return {
        ok: true,
        output: {
          message: ACK_TEXT,
          previousMode,
        },
        display: '↳ Plan mode active.',
      };
    },
  };
}
