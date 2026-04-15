// auditTypes.ts — SPEC-119: AuditEntry schema + constants.

import { z } from 'zod';

export const AuditEntrySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ts: z.number().int().positive(),
  sessionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  kind: z.enum(['tool_call', 'permission_decision']),
  toolName: z.string().min(1).max(64),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['ok', 'denied', 'error']),
  decisionReason: z.string().max(256).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AUDIT_LINE_MAX_BYTES = 4096;
