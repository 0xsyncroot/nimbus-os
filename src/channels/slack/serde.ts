// serde.ts — SPEC-804 T1: Slack message event ↔ ChannelInboundEvent + mrkdwn serialiser.
// Converts Slack message events to nimbus-os canonical types.
// All inbound content wrapped in <tool_output trusted="false"> per META-009.

import type { ChannelInboundEvent } from '../../core/eventTypes.ts';

/** Minimal Slack message event shape (from @slack/bolt or raw Events API). */
export interface SlackMessageEvent {
  type: 'message';
  channel: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

/**
 * Convert a Slack message event to a ChannelInboundEvent.
 * - Strips `<@UXXXXXXXX>` mention patterns from text.
 * - Wraps text in <tool_output trusted="false"> per META-009 trust boundary.
 */
export function slackEventToInbound(
  event: SlackMessageEvent,
  workspaceId: string,
): ChannelInboundEvent {
  const rawText = stripMentions(event.text ?? '');
  // META-009: wrap all inbound user content as untrusted.
  const wrappedText = `<tool_output trusted="false">${escapeXml(rawText)}</tool_output>`;
  return {
    type: 'channel.inbound',
    adapterId: 'slack',
    workspaceId,
    userId: event.user ?? event.bot_id ?? 'unknown',
    text: wrappedText,
    raw: event,
  };
}

/**
 * Convert plain text to Slack mrkdwn format.
 * Slack mrkdwn: *bold*, _italic_, `code`, ```code block```, ~strikethrough~.
 */
export function textToSlackMrkdwn(text: string): string {
  return (
    text
      // Code blocks (``` ... ```) pass through unchanged (Slack uses same syntax).
      // Inline code → Slack backtick (pass through as-is).
      // Bold **text** → *text* (Slack bold)
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Italic _text_ → _text_ (pass through — same in Slack)
      // Escape < > & in non-code portions to prevent Slack entity injection.
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  );
}

/** Strip Slack user mention patterns `<@UXXXXXXXX>` from text. */
function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

/** XML-escape for embedding text in pseudo-XML <tool_output> tags. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
