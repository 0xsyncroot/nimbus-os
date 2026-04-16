// bundled/research.ts — SPEC-320: Research skill definition.

import type { SkillDefinition } from '../types.ts';

export const researchSkill: SkillDefinition = {
  name: 'research',
  description: 'Investigate a question by reading files and searching the codebase, then synthesize findings.',
  whenToUse: 'research, investigate, trace the flow, how does X work, find where X is defined',
  allowedTools: ['Read', 'Grep', 'Glob'],
  permissions: { sideEffects: 'pure' },
  context: 'fork',
  source: 'bundled',
  body: `Investigate the following question: $ARGUMENTS

Structure your research as:
1. **Question** — restate what you're investigating
2. **Sources checked** — files read, patterns searched, paths explored
3. **Findings** — what you discovered, with file:line references
4. **Conclusion** — direct answer to the question
5. **Related areas** — other parts of the codebase worth knowing about`,
};
