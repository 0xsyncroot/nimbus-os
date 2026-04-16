// types.ts — SPEC-320: SkillDefinition type + Zod frontmatter schema.

import { z } from 'zod';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools?: string[];
  permissions: { sideEffects: 'pure' | 'read' | 'write' | 'exec' };
  context: 'inline' | 'fork';
  body: string; // markdown prompt template
  source: 'bundled' | 'workspace';
}

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().min(1),
  allowedTools: z.array(z.string()).optional(),
  permissions: z.object({
    sideEffects: z.enum(['pure', 'read', 'write', 'exec']),
  }),
  context: z.enum(['inline', 'fork']).default('inline'),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillResult {
  messages: import('../ir/types.ts').CanonicalMessage[];
  contextModifier?: { allowedTools?: string[] };
}
