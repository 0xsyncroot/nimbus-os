// bundled/debug.ts — SPEC-320: Debug skill definition.

import type { SkillDefinition } from '../types.ts';

export const debugSkill: SkillDefinition = {
  name: 'debug',
  description: 'Reproduce an error, identify root cause, and propose a minimal fix with test verification.',
  whenToUse: 'debug, why is this failing, fix this error, broken, crash, exception, stack trace',
  allowedTools: ['Bash', 'Read', 'Grep'],
  permissions: { sideEffects: 'exec' },
  context: 'inline',
  source: 'bundled',
  body: `Debug the following issue: $ARGUMENTS

Steps:
1. **Reproduce** — run the failing command/test to confirm the error
2. **Read the stack trace** — identify the exact file:line where it fails
3. **Trace the cause** — read relevant source files, find the code path that leads to the error
4. **Root cause** — state the root cause clearly in 1-2 sentences
5. **Proposed fix** — minimal diff that addresses the root cause without side effects
6. **Verify** — run tests to confirm the fix works and nothing regressed`,
};
