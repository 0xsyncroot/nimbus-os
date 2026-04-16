// activation.ts — SPEC-320: Skill activation — resolve, permission check, inject or fork.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import type { CanonicalMessage } from '../ir/types.ts';
import type { SkillDefinition, SkillResult } from './types.ts';

/** Registry passed in at activation time — avoids global mutable state. */
export interface SkillRegistry {
  get(name: string): SkillDefinition | undefined;
}

/** Minimal context needed by activateSkill. */
export interface ActivationContext {
  /** Source of activation: slash command or tool call */
  trigger: 'slash' | 'tool';
  /** Whether the current session allows exec-level side effects */
  allowExec?: boolean;
  /** Whether the current session allows write-level side effects */
  allowWrite?: boolean;
}

const SIDE_EFFECT_RANK: Record<SkillDefinition['permissions']['sideEffects'], number> = {
  pure: 0,
  read: 1,
  write: 2,
  exec: 3,
};

/**
 * Check whether the activation context permits the skill's sideEffects level.
 * Bundled skills are auto-allowed. Workspace skills require explicit session flags
 * for write/exec (simulating the permission gate from SPEC-401).
 */
function checkPermission(skill: SkillDefinition, ctx: ActivationContext): void {
  if (skill.source === 'bundled') return; // bundled skills are trusted

  const rank = SIDE_EFFECT_RANK[skill.permissions.sideEffects];

  if (rank >= SIDE_EFFECT_RANK['exec'] && !ctx.allowExec) {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      skill: skill.name,
      sideEffects: skill.permissions.sideEffects,
      reason: 'workspace skill requires exec permission — confirm first',
    });
  }

  if (rank >= SIDE_EFFECT_RANK['write'] && !ctx.allowWrite && !ctx.allowExec) {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      skill: skill.name,
      sideEffects: skill.permissions.sideEffects,
      reason: 'workspace skill requires write permission — confirm first',
    });
  }
}

/**
 * Render the skill body by substituting `$ARGUMENTS` with the provided args string.
 */
function renderBody(body: string, args: string): string {
  return body.replace(/\$ARGUMENTS/g, args);
}

/**
 * Activate a skill by name with the given arguments.
 * Returns a SkillResult containing the injected messages and any context modifier.
 *
 * For inline context: returns a user message with the rendered skill body.
 * For fork context: also returns a user message (fork dispatch is handled by the caller).
 */
export function activateSkill(
  name: string,
  args: string,
  registry: SkillRegistry,
  ctx: ActivationContext,
): SkillResult {
  const skill = registry.get(name);
  if (!skill) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, {
      skill: name,
      reason: 'skill not found in registry',
    });
  }

  checkPermission(skill, ctx);

  const rendered = renderBody(skill.body, args);

  logger.debug(
    { name, source: skill.source, context: skill.context, trigger: ctx.trigger },
    'activating skill',
  );

  const messages: CanonicalMessage[] = [
    { role: 'user', content: rendered },
  ];

  const contextModifier =
    skill.allowedTools && skill.allowedTools.length > 0
      ? { allowedTools: skill.allowedTools }
      : undefined;

  return { messages, contextModifier };
}

/**
 * Parse a slash command string like "/plan build a REST API" into name + args.
 * Returns null if the string is not a slash command.
 */
export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const rest = trimmed.slice(1); // strip leading /
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx === -1) {
    return { name: rest, args: '' };
  }
  return {
    name: rest.slice(0, spaceIdx),
    args: rest.slice(spaceIdx + 1).trim(),
  };
}
