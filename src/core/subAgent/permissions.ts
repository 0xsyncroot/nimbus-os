// permissions.ts — SPEC-130 T5: permission lattice for sub-agents.
// narrow(parent, opts) → ChildPermissions: intersection only, mode DOWN only.
// Pure TS, no Bun APIs. No class-based inheritance.

import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import type { PermissionMode } from '../../permissions/mode.ts';

export type SubAgentMode = Extract<PermissionMode, 'readonly' | 'default' | 'bypass'>;

/** Ordered lattice: readonly ⊂ default ⊂ bypass (higher index = more permissive). */
const MODE_RANK: Record<SubAgentMode, number> = {
  readonly: 0,
  default: 1,
  bypass: 2,
} as const;

export interface ChildPermissions {
  mode: SubAgentMode;
  allowedBashPatterns: string[];   // intersection with parent's allowlist
  deniedTools: Set<string>;        // union of parent denies + child extra denies
}

export interface NarrowOpts {
  /** Requested mode for child. Must be <= parent mode. */
  mode?: SubAgentMode;
  /** Bash allowlist patterns the child requests (intersected with parent's). */
  narrowBash?: string[];
  /** Extra tools to deny in child (added to parent denies). */
  denyTools?: string[];
}

export interface ParentPermissions {
  mode: SubAgentMode;
  allowedBashPatterns: string[];
  deniedTools: Set<string>;
}

/**
 * Compute child permissions by intersecting/narrowing parent permissions.
 * Throws T_PERMISSION if child requests a wider mode than parent.
 */
export function narrow(parent: ParentPermissions, opts: NarrowOpts): ChildPermissions {
  // 1. Mode: child can only move DOWN the lattice.
  const requestedMode: SubAgentMode = opts.mode ?? parent.mode;
  if (MODE_RANK[requestedMode] > MODE_RANK[parent.mode]) {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'sub_agent_mode_wider_than_parent',
      parentMode: parent.mode,
      requestedMode,
    });
  }

  // 2. Bash allowlist: INTERSECTION only. If child requests patterns not in parent → exclude.
  let allowedBashPatterns: string[];
  if (opts.narrowBash !== undefined) {
    const parentSet = new Set(parent.allowedBashPatterns);
    allowedBashPatterns = opts.narrowBash.filter((p) => parentSet.has(p));
  } else {
    // Inherit parent's list if no narrowing requested.
    allowedBashPatterns = [...parent.allowedBashPatterns];
  }

  // 3. Denied tools: UNION (child adds more denies on top of parent).
  const deniedTools = new Set<string>(parent.deniedTools);
  if (opts.denyTools) {
    for (const t of opts.denyTools) {
      deniedTools.add(t);
    }
  }

  return { mode: requestedMode, allowedBashPatterns, deniedTools };
}

/**
 * Returns true if a tool is allowed given child permissions.
 * Denied tools always lose regardless of mode.
 */
export function canUseToolWithPermissions(
  toolName: string,
  permissions: ChildPermissions,
): boolean {
  if (permissions.deniedTools.has(toolName)) return false;
  // For readonly mode: only allow safe read tools.
  if (permissions.mode === 'readonly') {
    const READONLY_SAFE = new Set(['Read', 'Grep', 'Glob', 'Ls', 'WebFetch', 'WebSearch']);
    return READONLY_SAFE.has(toolName);
  }
  return true;
}

/** Build a default parent permission from a TurnContext mode. */
export function defaultParentPermissions(mode: PermissionMode): ParentPermissions {
  const safeMode: SubAgentMode =
    mode === 'bypass' ? 'bypass' :
    mode === 'readonly' ? 'readonly' :
    'default';
  return {
    mode: safeMode,
    allowedBashPatterns: [],
    deniedTools: new Set<string>(),
  };
}
