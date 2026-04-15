// types.ts — SPEC-401/402: shared permission interfaces.

import type { PermissionMode } from './mode.ts';

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
}

export interface PermissionContext {
  sessionId: string;
  workspaceId: string;
  mode: PermissionMode;
  cwd: string;
}
