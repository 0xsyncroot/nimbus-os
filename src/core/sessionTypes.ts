// sessionTypes.ts — SPEC-102 schemas.

import { z } from 'zod';

export const SESSION_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const SessionMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(SESSION_ULID),
  wsId: z.string().regex(SESSION_ULID),
  createdAt: z.number().int().positive(),
  lastMessage: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  recoveredLines: z.number().int().nonnegative().default(0),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const MessageLineSchema = z.object({
  schemaVersion: z.literal(1),
  turnId: z.string(),
  message: z.unknown(),
  ts: z.number().int().positive(),
});
export type MessageLine = z.infer<typeof MessageLineSchema>;

export type StoredSessionEvent =
  | { eventId: number; ts: number; type: 'user_msg'; text: string }
  | { eventId: number; ts: number; type: 'assistant_start'; turnId: string }
  | { eventId: number; ts: number; type: 'assistant_end'; turnId: string; tokens: number }
  | { eventId: number; ts: number; type: 'assistant_msg'; turnId: string; text: string }
  | { eventId: number; ts: number; type: 'tool_start'; toolUseId: string; name: string }
  | { eventId: number; ts: number; type: 'tool_end'; toolUseId: string; ok: boolean }
  | { eventId: number; ts: number; type: 'tool_invocation'; turnId: string; toolUseId: string; name: string; inputDigest: string }
  | { eventId: number; ts: number; type: 'tool_result'; turnId: string; toolUseId: string; name: string; ok: boolean; ms: number }
  | { eventId: number; ts: number; type: 'plan_announce'; turnId: string; reason: string; heuristic: string }
  | { eventId: number; ts: number; type: 'spec_generated'; turnId: string; summary: string }
  | {
      eventId: number;
      ts: number;
      type: 'usage';
      turnId: string;
      model: string;
      provider: string;
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | { eventId: number; ts: number; type: 'turn_complete'; turnId: string; ok: boolean; ms: number };

export const MAX_LINE_BYTES = 256 * 1024;
export const ROTATE_AT_BYTES = 100 * 1024 * 1024;
