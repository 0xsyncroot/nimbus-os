// bundled/summarize.ts — SPEC-320: Summarize skill definition.

import type { SkillDefinition } from '../types.ts';

export const summarizeSkill: SkillDefinition = {
  name: 'summarize',
  description: 'Read the specified content and produce a structured summary.',
  whenToUse: 'summarize, tldr, what does this do, give me an overview, explain this',
  allowedTools: ['Read', 'Grep'],
  permissions: { sideEffects: 'pure' },
  context: 'inline',
  source: 'bundled',
  body: `Read and summarize the following: $ARGUMENTS

Structure your summary as:
- **TL;DR** (1-2 sentences): core purpose or finding
- **Key points** (bullets): most important facts, decisions, or features
- **Details worth noting**: non-obvious behavior, edge cases, caveats
- **Open questions**: anything unclear or that needs follow-up`,
};
