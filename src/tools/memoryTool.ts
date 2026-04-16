// memoryTool.ts — SPEC-122: extended Memory tool with setSessionPref action.
// Wraps the existing Memory.ts append logic and adds session preference management.

import { z } from 'zod';
import { ErrorCode, NimbusError, wrapError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { SessionPreferencesSchema } from '../core/sessionPreferences.ts';
import { setSessionPref } from '../core/sessionPreferences.ts';
import { detectCrossSessionIntent } from '../core/sessionPreferences.ts';
import type { SessionPreferences } from '../core/sessionPreferences.ts';
import type { Tool } from './types.ts';

// ---------------------------------------------------------------------------
// Input schema — union of actions
// ---------------------------------------------------------------------------

export const MemoryToolInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    scope: z.enum(['memory', 'soul', 'identity']),
  }),
  z.object({
    action: z.literal('append'),
    scope: z.literal('memory'),
    content: z.string().min(1).max(4096),
  }),
  z.object({
    action: z.literal('setSessionPref'),
    key: z.enum(['agentName', 'pronoun', 'language', 'voice'] as const),
    value: z.string().min(1).max(128),
  }),
]);

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

export type MemoryToolAction =
  | { action: 'read'; scope: 'memory' | 'soul' | 'identity' }
  | { action: 'append'; scope: 'memory'; content: string }
  | { action: 'setSessionPref'; key: keyof SessionPreferences; value: string };

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type MemoryToolOutput =
  | { action: 'read'; scope: string; content: string }
  | { action: 'append'; appendedBytes: number }
  | { action: 'setSessionPref'; key: string; value: string; crossSessionOffered: boolean };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryExtendedTool(): Tool<MemoryToolInput, MemoryToolOutput> {
  return {
    name: 'MemoryTool',
    description:
      'Manage session memory and preferences. Actions: read (soul/memory/identity), append (memory), setSessionPref (agentName/pronoun/language/voice).',
    readOnly: false,
    inputSchema: MemoryToolInputSchema,

    async handler(input, ctx) {
      try {
        if (input.action === 'setSessionPref') {
          const { key, value } = input;

          // Detect cross-session promotion intent (log only, never auto-write)
          const crossSessionOffered = detectCrossSessionIntent(value) || detectCrossSessionIntent(key);
          if (crossSessionOffered) {
            logger.info(
              { sessionId: ctx.sessionId, key },
              'sessionPref.crossSession.promotionDetected — user should be offered promotion to MEMORY.md',
            );
          }

          await setSessionPref(ctx.workspaceId, ctx.sessionId, key as keyof SessionPreferences, value);

          return {
            ok: true,
            output: { action: 'setSessionPref' as const, key, value, crossSessionOffered },
            display: `Session preference set: ${key} = ${value}${crossSessionOffered ? ' (consider promoting to MEMORY.md for persistence across sessions)' : ''}`,
          };
        }

        if (input.action === 'read') {
          // Read-only: the actual reading is handled by callers who have direct
          // access to WorkspaceMemory. Here we signal unsupported gracefully.
          return {
            ok: false,
            error: new NimbusError(ErrorCode.U_BAD_COMMAND, {
              reason: 'read_via_memory_tool_not_supported',
              hint: 'WorkspaceMemory is loaded by the agent loop; use direct SOUL/MEMORY/IDENTITY blocks in context',
            }),
          };
        }

        if (input.action === 'append') {
          return {
            ok: false,
            error: new NimbusError(ErrorCode.U_BAD_COMMAND, {
              reason: 'use_Memory_tool_for_append',
              hint: 'Use the Memory tool (builtin/Memory.ts) for MEMORY.md append operations',
            }),
          };
        }

        // Exhaustive check — TypeScript should catch this at compile time
        const _never: never = input;
        logger.error({ input: _never }, 'memoryTool.unhandled_action');
        return {
          ok: false,
          error: new NimbusError(ErrorCode.T_CRASH, { reason: 'unhandled_action' }),
        };
      } catch (err) {
        return { ok: false, error: err instanceof NimbusError ? err : wrapError(err) };
      }
    },
  };
}
