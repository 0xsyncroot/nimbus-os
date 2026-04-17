// intent.ts — SPEC-830: UIIntent discriminated union + UIContext + UIResult types.
// Pure TS: no Bun APIs, no node:* imports — reusable from future mobile client.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// UIIntent — discriminated union of all interactive prompt variants.
// Payloads are plain serializable data (no functions, no bigints).
// ---------------------------------------------------------------------------

export type UIIntent =
  | { kind: 'confirm'; prompt: string; defaultValue?: boolean; timeoutMs?: number }
  | { kind: 'pick'; prompt: string; options: Array<{ id: string; label: string; hint?: string }> }
  | { kind: 'input'; prompt: string; secret?: boolean; placeholder?: string }
  | { kind: 'status'; message: string; level: 'info' | 'warn' | 'error' }
  // SPEC-846: permission intent — dispatches to <PermissionRequest> in CLI UIHost.
  // allowAlways=false suppresses "Yes, and don't ask again" (META-009 T23 unsafe prefix).
  | { kind: 'permission'; toolName: string; detail: string; allowAlways: boolean };

// UIResult value for 'permission' kind — narrowed to the 3 response options.
export type PermissionResponse = 'allow' | 'always' | 'deny';

// ---------------------------------------------------------------------------
// UIContext — per-turn request context; channel-agnostic.
// ---------------------------------------------------------------------------

export interface UIContext {
  turnId: string;
  correlationId: string;
  channelId: 'cli' | 'telegram' | 'slack' | 'http';
  abortSignal: AbortSignal;
}

// ---------------------------------------------------------------------------
// UIResult — discriminated response shape; T is the success value type.
// ---------------------------------------------------------------------------

export type UIResult<T = unknown> =
  | { kind: 'ok'; value: T }
  | { kind: 'cancel' }
  | { kind: 'timeout' };

// ---------------------------------------------------------------------------
// Zod schemas for UIIntent payloads — used at channel inbound boundaries.
// (AbortSignal is not serializable; UIContext schema validated separately.)
// ---------------------------------------------------------------------------

const uiPickOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

export const uiIntentConfirmSchema = z.object({
  kind: z.literal('confirm'),
  prompt: z.string().min(1),
  defaultValue: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const uiIntentPickSchema = z.object({
  kind: z.literal('pick'),
  prompt: z.string().min(1),
  options: z.array(uiPickOptionSchema).min(1),
});

export const uiIntentInputSchema = z.object({
  kind: z.literal('input'),
  prompt: z.string().min(1),
  secret: z.boolean().optional(),
  placeholder: z.string().optional(),
});

export const uiIntentStatusSchema = z.object({
  kind: z.literal('status'),
  message: z.string().min(1),
  level: z.enum(['info', 'warn', 'error']),
});

export const uiIntentPermissionSchema = z.object({
  kind: z.literal('permission'),
  toolName: z.string().min(1),
  detail: z.string(),
  allowAlways: z.boolean(),
});

export const uiIntentSchema = z.discriminatedUnion('kind', [
  uiIntentConfirmSchema,
  uiIntentPickSchema,
  uiIntentInputSchema,
  uiIntentStatusSchema,
  uiIntentPermissionSchema,
]);

// ---------------------------------------------------------------------------
// Exhaustiveness helper — compile-time guarantee for switch coverage.
// ---------------------------------------------------------------------------

export function assertExhaustiveIntent(x: never): never {
  throw new Error(`Unhandled UIIntent kind: ${String((x as { kind: unknown }).kind)}`);
}
