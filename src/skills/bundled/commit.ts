// bundled/commit.ts — SPEC-320: Commit skill definition.

import type { SkillDefinition } from '../types.ts';

export const commitSkill: SkillDefinition = {
  name: 'commit',
  description: 'Analyze staged changes and draft a well-formed git commit message for user confirmation.',
  whenToUse: 'commit, save changes, git commit, create a commit',
  allowedTools: ['Bash', 'Read'],
  permissions: { sideEffects: 'write' },
  context: 'inline',
  source: 'bundled',
  body: `Prepare a git commit for: $ARGUMENTS

Steps:
1. Run \`git status\` to see what's changed
2. Run \`git diff --cached\` to see staged changes (and \`git diff\` for unstaged)
3. Analyze the changes — understand the *why*, not just the *what*
4. Draft a commit message:
   - **Subject** (imperative mood, ≤72 chars): what this commit does
   - **Body** (optional): why this change was made, any trade-offs
5. Show the draft to the user and **ask for confirmation before committing**`,
};
