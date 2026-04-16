// frontmatter.ts — SPEC-320: Parse SKILL.md with gray-matter + validate frontmatter.

import matter from 'gray-matter';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { SkillFrontmatterSchema, type SkillDefinition } from './types.ts';

/**
 * Parse a SKILL.md string into a SkillDefinition.
 * Throws NimbusError(S_SOUL_PARSE) on any malformed input.
 */
export function parseFrontmatter(
  content: string,
  source: SkillDefinition['source'],
  filePath?: string,
): SkillDefinition {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new NimbusError(
      ErrorCode.S_SOUL_PARSE,
      { filePath, reason: 'gray-matter parse failed', err: String(err) },
      err instanceof Error ? err : undefined,
    );
  }

  const result = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    logger.warn({ filePath, issues: result.error.issues }, 'skill frontmatter validation failed');
    throw new NimbusError(
      ErrorCode.S_SOUL_PARSE,
      { filePath, issues: result.error.issues.map((i) => i.message) },
    );
  }

  const fm = result.data;
  const body = parsed.content.trim();

  if (!body) {
    throw new NimbusError(
      ErrorCode.S_SOUL_PARSE,
      { filePath, reason: 'SKILL.md body is empty' },
    );
  }

  return {
    name: fm.name,
    description: fm.description,
    whenToUse: fm.whenToUse,
    allowedTools: fm.allowedTools,
    permissions: fm.permissions,
    context: fm.context,
    body,
    source,
  };
}
