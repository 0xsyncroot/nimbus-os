// bundled/organize.ts — SPEC-320: Organize skill definition.

import type { SkillDefinition } from '../types.ts';

export const organizeSkill: SkillDefinition = {
  name: 'organize',
  description: 'Analyze a directory structure and propose a reorganization plan before making any moves.',
  whenToUse: 'organize, restructure, clean up, tidy, reorganize, sort files',
  allowedTools: ['Bash', 'Read', 'Write'],
  permissions: { sideEffects: 'exec' },
  context: 'inline',
  source: 'bundled',
  body: `Analyze the target directory or codebase: $ARGUMENTS

Steps:
1. List the current structure (use Bash/Read to explore)
2. Identify issues: naming inconsistencies, misplaced files, duplicate logic
3. Propose a reorganization plan showing **before → after** for each change
4. **Confirm with the user before executing any moves or renames**
5. After confirmation, apply changes and report what was done`,
};
