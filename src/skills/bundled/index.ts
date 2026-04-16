// bundled/index.ts — SPEC-320: Register all 7 bundled skills.

import type { SkillDefinition } from '../types.ts';
import { planSkill } from './plan.ts';
import { summarizeSkill } from './summarize.ts';
import { organizeSkill } from './organize.ts';
import { commitSkill } from './commit.ts';
import { researchSkill } from './research.ts';
import { codeReviewSkill } from './codeReview.ts';
import { debugSkill } from './debug.ts';

const BUNDLED_SKILLS: readonly SkillDefinition[] = [
  planSkill,
  summarizeSkill,
  organizeSkill,
  commitSkill,
  researchSkill,
  codeReviewSkill,
  debugSkill,
];

export function getBundledSkills(): readonly SkillDefinition[] {
  return BUNDLED_SKILLS;
}

export function registerBundledSkill(def: Omit<SkillDefinition, 'source'>): SkillDefinition {
  return { ...def, source: 'bundled' };
}
