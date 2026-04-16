// loader.ts — SPEC-320: Load bundled + workspace skills, merge with workspace override.

import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { getBundledSkills } from './bundled/index.ts';
import type { SkillDefinition } from './types.ts';

/**
 * Scan `workspaceDir/skills/ * /SKILL.md` and parse each skill.
 * Malformed SKILL.md files are logged and skipped (non-fatal).
 */
export async function loadWorkspaceSkills(workspaceDir: string): Promise<Map<string, SkillDefinition>> {
  const skillsDir = join(workspaceDir, 'skills');
  const map = new Map<string, SkillDefinition>();

  let entries: string[];
  try {
    const dirents = await readdir(skillsDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err: unknown) {
    // Skills directory doesn't exist — that's OK
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return map;
    }
    throw new NimbusError(
      ErrorCode.T_NOT_FOUND,
      { skillsDir, reason: 'cannot read skills directory' },
      err instanceof Error ? err : undefined,
    );
  }

  const start = Date.now();

  for (const entry of entries) {
    const skillFile = join(skillsDir, entry, 'SKILL.md');
    let content: string;
    try {
      content = await readFile(skillFile, 'utf-8');
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'ENOENT'
      ) {
        logger.debug({ skillFile }, 'SKILL.md not found in skills sub-directory, skipping');
        continue;
      }
      logger.warn({ skillFile, err: String(err) }, 'failed to read SKILL.md, skipping');
      continue;
    }

    try {
      const skill = parseFrontmatter(content, 'workspace', skillFile);
      map.set(skill.name, skill);
      logger.debug({ name: skill.name }, 'loaded workspace skill');
    } catch (err) {
      logger.warn({ skillFile, err: (err as Error).message }, 'malformed SKILL.md, skipping');
    }
  }

  const elapsed = Date.now() - start;
  logger.debug({ count: map.size, elapsed }, 'workspace skills loaded');

  return map;
}

/**
 * Load all bundled skills from the bundled registry.
 */
export function loadBundledSkills(): Map<string, SkillDefinition> {
  const skills = getBundledSkills();
  const map = new Map<string, SkillDefinition>();
  for (const skill of skills) {
    map.set(skill.name, skill);
  }
  return map;
}

/**
 * Merge bundled + workspace skills. Workspace overrides bundled by name.
 * Returns a Map ready for activation lookup.
 */
export async function loadSkills(workspaceDir: string): Promise<Map<string, SkillDefinition>> {
  const bundled = loadBundledSkills();
  const workspace = await loadWorkspaceSkills(workspaceDir);

  // Workspace overrides bundled — start with bundled then overwrite
  const merged = new Map<string, SkillDefinition>(bundled);
  for (const [name, skill] of workspace) {
    if (merged.has(name)) {
      logger.debug({ name }, 'workspace skill overrides bundled');
    }
    merged.set(name, skill);
  }

  logger.debug({ total: merged.size, bundled: bundled.size, workspace: workspace.size }, 'skills merged');
  return merged;
}
