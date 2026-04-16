// bundled/codeReview.ts — SPEC-320: Code review skill definition.

import type { SkillDefinition } from '../types.ts';

export const codeReviewSkill: SkillDefinition = {
  name: 'codeReview',
  description: 'Review code for correctness, security, performance, readability, and test coverage gaps.',
  whenToUse: 'review this, code review, check this code, review PR, audit this',
  allowedTools: ['Read', 'Grep'],
  permissions: { sideEffects: 'pure' },
  context: 'inline',
  source: 'bundled',
  body: `Review the following code: $ARGUMENTS

Check each dimension and list findings as \`file:line [SEVERITY] description\`:

**Correctness**: logic errors, off-by-ones, incorrect assumptions, missing null checks
**Security** (OWASP Top 10): injection, broken auth, sensitive data exposure, missing validation
**Performance**: unnecessary allocations, N+1 queries, blocking I/O, large loops
**Readability**: naming clarity, code duplication, overly complex logic, missing comments
**Test coverage gaps**: untested branches, missing edge cases, missing error paths

Severity levels: CRITICAL / HIGH / MEDIUM / LOW / INFO

End with a brief overall assessment and top 3 recommendations.`,
};
