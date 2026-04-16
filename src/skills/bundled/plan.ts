// bundled/plan.ts — SPEC-320: Plan skill definition.

import type { SkillDefinition } from '../types.ts';

export const planSkill: SkillDefinition = {
  name: 'plan',
  description: 'Break a task into a numbered step-by-step plan with acceptance criteria and effort estimates.',
  whenToUse: 'make a plan, break this down, plan this out, how should I approach',
  allowedTools: ['Read', 'Write'],
  permissions: { sideEffects: 'write' },
  context: 'inline',
  source: 'bundled',
  body: `Break this task into numbered steps: $ARGUMENTS

For each step, provide:
1. **What to do** — clear, actionable description
2. **Acceptance criteria** — how to know it's done
3. **Estimated effort** — (XS/S/M/L/XL)

If the intent is ambiguous, ask 1-3 clarifying questions before producing the plan.
Highlight any steps that carry risk or require user confirmation.`,
};
