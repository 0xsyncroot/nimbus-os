// receiveMessage.ts — SPEC-131 T5: poll own mailbox with optional filters.
// sideEffects: 'read' (SPEC-301 partition). Returns trust-wrapped messages.

import { z } from 'zod';
import { getOrCreateMailbox } from './subAgent/mailbox.ts';
import { wrapUntrusted, wrapTrusted } from './subAgent/trustWrap.ts';
import type { Tool } from './types.ts';
import type { MailMessage } from './subAgent/mailbox.ts';

export const ReceiveMessageInputSchema = z.object({
  from: z.string().optional().describe('Filter by sender agent ID'),
  since: z.number().optional().describe('Return only messages after this timestamp (ms)'),
  limit: z.number().int().positive().max(256).optional().describe('Max messages to return'),
}).strict();

export type ReceiveMessageInput = z.infer<typeof ReceiveMessageInputSchema>;

export interface ReceiveMessageOutput {
  messages: Array<{
    id: string;
    from: string;
    type: string;
    timestamp: number;
    content: string;
  }>;
  count: number;
}

function renderMessage(msg: MailMessage): string {
  const payload = msg.payload !== null && msg.payload !== undefined
    ? JSON.stringify(msg.payload)
    : '';
  return msg.trust === 'untrusted'
    ? wrapUntrusted(`[${msg.type}] ${payload}`, `agent:${msg.from}`).text
    : wrapTrusted(`[${msg.type}] ${payload}`).text;
}

export function createReceiveMessageTool(): Tool<ReceiveMessageInput, ReceiveMessageOutput> {
  return {
    name: 'ReceiveMessage',
    description:
      'Poll own mailbox for messages. Returns up to 256 messages, optionally filtered by ' +
      'sender, since timestamp, or count. Sub-agent messages are trust-wrapped.',
    readOnly: true,
    inputSchema: ReceiveMessageInputSchema,
    async handler(input, ctx) {
      const mailbox = getOrCreateMailbox(ctx.workspaceId, ctx.sessionId);
      const msgs = mailbox.receive({
        from: input.from,
        since: input.since,
        limit: input.limit,
      });

      const output: ReceiveMessageOutput = {
        messages: msgs.map((m) => ({
          id: m.id,
          from: m.from,
          type: m.type,
          timestamp: m.timestamp,
          content: renderMessage(m),
        })),
        count: msgs.length,
      };

      return {
        ok: true,
        output,
        display: `Received ${msgs.length} message(s)`,
      };
    },
  };
}
