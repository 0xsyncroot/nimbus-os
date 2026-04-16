// sendMessage.ts — SPEC-131 T4: non-blocking enqueue into target agent's mailbox.
// sideEffects: 'write' (SPEC-301 partition).

import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { getOrCreateMailbox } from './subAgent/mailbox.ts';
import type { Tool } from './types.ts';

export const SendMessageInputSchema = z.object({
  to: z.string().min(1).describe('Target agent ID or "*" for broadcast'),
  type: z
    .enum(['task_assignment', 'task_result', 'status_update', 'error', 'cancel', 'heartbeat'])
    .default('status_update')
    .describe('Message type'),
  payload: z.unknown().optional().describe('Message payload (type-specific)'),
}).strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export interface SendMessageOutput {
  id: string;
  delivered: boolean;
}

export function createSendMessageTool(): Tool<SendMessageInput, SendMessageOutput> {
  return {
    name: 'SendMessage',
    description:
      'Non-blocking enqueue of a message into a target agent\'s mailbox. ' +
      'Returns message ID + delivery acknowledgement.',
    readOnly: false,
    inputSchema: SendMessageInputSchema,
    async handler(input, ctx) {
      const mailbox = getOrCreateMailbox(ctx.workspaceId, input.to);

      let msg;
      try {
        msg = mailbox.deliver({
          from: ctx.sessionId,
          to: input.to,
          type: input.type,
          payload: input.payload ?? null,
          trust: 'trusted',
        });
      } catch (err) {
        throw new NimbusError(ErrorCode.T_CRASH, {
          reason: 'mailbox_deliver_failed',
          to: input.to,
          err: (err as Error).message,
        });
      }

      return {
        ok: true,
        output: { id: msg.id, delivered: true },
        display: `Message ${msg.id} delivered to ${input.to}`,
      };
    },
  };
}
