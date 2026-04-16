// serde.ts — SPEC-803 T1: Telegram Message ↔ ChannelInboundEvent + HTML serialiser.
// Converts grammY-compatible Message shapes to nimbus-os canonical types.
// All inbound content wrapped in <tool_output trusted="false"> per META-009.

import type { ChannelInboundEvent } from '../../core/eventTypes.ts';

/** Minimal Telegram Message shape (grammY-compatible). */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name: string; username?: string };
  text?: string;
  date: number;
}

/**
 * Convert a Telegram Message to a ChannelInboundEvent.
 * Wraps text in <tool_output trusted="false"> per META-009 trust boundary.
 */
export function telegramMsgToEvent(
  msg: TelegramMessage,
  workspaceId: string,
): ChannelInboundEvent {
  const rawText = msg.text ?? '';
  // META-009: all inbound user content must be wrapped as untrusted tool output.
  const wrappedText = `<tool_output trusted="false">${escapeHtmlEntities(rawText)}</tool_output>`;
  return {
    type: 'channel.inbound',
    adapterId: 'telegram',
    workspaceId,
    userId: String(msg.from?.id ?? msg.chat.id),
    text: wrappedText,
    raw: msg,
  };
}

/**
 * Convert plain text to Telegram HTML format.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <tg-spoiler>.
 * We convert markdown-ish patterns to Telegram HTML.
 */
export function textToTelegramHtml(text: string): string {
  return (
    text
      // Escape raw HTML entities first to prevent XSS-style injection.
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Code blocks (``` ... ```) → <pre>
      .replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.trim()}</pre>`)
      // Inline code → <code>
      .replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`)
      // Bold **text** → <b>text</b>
      .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => `<b>${t}</b>`)
      // Italic _text_ → <i>text</i>
      .replace(/(?<![*_])_([^_]+)_(?![*_])/g, (_m, t: string) => `<i>${t}</i>`)
  );
}

/** Escape HTML entities for safe embedding inside tag content. */
function escapeHtmlEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
