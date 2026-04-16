// types.ts — SPEC-401/402: shared permission interfaces.

import type { PermissionMode } from './mode.ts';

export type SideEffectTier = 'pure' | 'read' | 'write' | 'exec';

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
  /** SPEC-404: side-effect tier from SPEC-301 four-category enum. Optional — callers that
   *  know the tier should populate this so acceptEdits fast-path can skip rule matching. */
  sideEffects?: SideEffectTier;
}

export interface PermissionContext {
  sessionId: string;
  workspaceId: string;
  mode: PermissionMode;
  cwd: string;
}
