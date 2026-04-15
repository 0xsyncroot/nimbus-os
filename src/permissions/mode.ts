// mode.ts — SPEC-401: PermissionMode enum, registry + v0.2 stubs.

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { Decision } from './rule.ts';

export const PermissionModeSchema = z.enum([
  'readonly',
  'default',
  'bypass',
  'plan',
  'auto',
  'isolated',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const IMPLEMENTED_MODES: ReadonlySet<PermissionMode> = new Set([
  'readonly',
  'default',
  'bypass',
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
  bypass: {
    name: 'bypass',
    describe: () => 'Bypass: allow all (requires NIMBUS_BYPASS_CONFIRMED=1 + --dangerously-skip-permissions)',
    implemented: true,
  },
  plan: { name: 'plan', describe: () => 'v0.2 stub', implemented: false },
  auto: { name: 'auto', describe: () => 'v0.2 stub', implemented: false },
  isolated: { name: 'isolated', describe: () => 'v0.2 stub', implemented: false },
};

export function getModeDescriptor(mode: PermissionMode): ModeDescriptor {
  const d = DESCRIPTORS[mode];
  if (!d) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { mode, reason: 'unknown-mode' });
  }
  return d;
}

export type ModeDecision = Decision;
