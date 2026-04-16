// mode.ts — SPEC-401/404: PermissionMode enum, registry, parseMode, narrow.
// SPEC-133: plan mode enabled + PLAN_MODE_ALLOWED_TOOLS whitelist.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { Decision } from './rule.ts';

export const PermissionModeSchema = z.enum([
  'readonly',
  'default',
  'acceptEdits',
  'bypass',
  'plan',
  'isolated',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const IMPLEMENTED_MODES: ReadonlySet<PermissionMode> = new Set([
  'readonly',
  'default',
  'acceptEdits',
  'bypass',
  'plan',
]);

export const READONLY_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'Ls',
  'WebFetch',
  'WebSearch',
]);

export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'NotebookEdit',
]);

/**
 * SPEC-133: Tools permitted while the agent is in plan mode.
 * Enforced at executor (loop.ts + gate.ts) — name-based whitelist is explicit
 * and auditable; side-effect mis-classification cannot widen the gate.
 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * SPEC-133: Returns true when toolName is allowed while agent mode is 'plan'.
 */
export function isAllowedInPlanMode(toolName: string): boolean {
  return PLAN_MODE_ALLOWED_TOOLS.has(toolName);
}

export function assertImplemented(mode: PermissionMode): void {
  if (IMPLEMENTED_MODES.has(mode)) return;
  throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
    mode,
    reason: 'not-implemented-until-v0.2',
  });
}

export function isValidTransition(from: PermissionMode, to: PermissionMode): boolean {
  if (!IMPLEMENTED_MODES.has(to)) return false;
  if (from === to) return true;
  return true;
}

export interface ModeDescriptor {
  name: PermissionMode;
  describe(): string;
  implemented: boolean;
}

const DESCRIPTORS: Record<PermissionMode, ModeDescriptor> = {
  readonly: {
    name: 'readonly',
    describe: () => 'Read-only: Read/Grep/Glob allowed; Write/Edit/Bash denied',
    implemented: true,
  },
  default: {
    name: 'default',
    describe: () => 'Default: rule-matched; unknown → ask',
    implemented: true,
  },
  acceptEdits: {
    name: 'acceptEdits',
    describe: () => 'Accept-edits: write-tier tools auto-allowed; exec (Bash) still prompts',
    implemented: true,
  },
  bypass: {
    name: 'bypass',
    describe: () => 'Bypass: allow all (requires NIMBUS_BYPASS_CONFIRMED=1 + --dangerously-skip-permissions)',
    implemented: true,
  },
  plan: {
    name: 'plan',
    describe: () => 'Plan: read-only exploration + ExitPlanMode to propose; Write/Edit/Bash denied',
    implemented: true,
  },
  isolated: { name: 'isolated', describe: () => 'v0.2 stub', implemented: false },
};

export function getModeDescriptor(mode: PermissionMode): ModeDescriptor {
  const d = DESCRIPTORS[mode];
  if (!d) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { mode, reason: 'unknown-mode' });
  }
  return d;
}

/**
 * parseMode — SPEC-404 T1.
 * Resolves raw string to a PermissionMode. 'auto' is an alias for 'acceptEdits'.
 * Unknown values throw NimbusError(U_BAD_COMMAND).
 */
export function parseMode(raw: string): PermissionMode {
  if (raw === 'auto') return 'acceptEdits';
  const result = PermissionModeSchema.safeParse(raw);
  if (!result.success) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { raw, reason: 'unknown_permission_mode' });
  }
  return result.data;
}

/**
 * LATTICE_RANK — ordinal width of each mode (higher = more permissive).
 * 'plan' and 'isolated' are orthogonal — treated narrower than default for safety.
 * Used by narrow() to enforce non-widening in sub-agent inheritance.
 */
const LATTICE_RANK: Record<PermissionMode, number> = {
  readonly: 0,
  isolated: 1,
  plan: 1,
  default: 2,
  acceptEdits: 3,
  bypass: 4,
};

/**
 * narrow — SPEC-404 T4. Sub-agent permission inheritance.
 * Returns the more restrictive of parent and requested mode.
 * Throws NimbusError(T_PERMISSION) if requested is wider than parent.
 */
export function narrow(parent: PermissionMode, requested: PermissionMode): PermissionMode {
  const parentRank = LATTICE_RANK[parent];
  const requestedRank = LATTICE_RANK[requested];
  if (requestedRank > parentRank) {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'cannot_widen_sub_agent_mode',
      parent,
      requested,
    });
  }
  return requested;
}

export type ModeDecision = Decision;
