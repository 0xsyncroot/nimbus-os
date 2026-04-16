// draftEdit.ts — SPEC-804 T4: Slack Block Kit approval UI + draft-edit pattern.
// - buildApprovalBlocks: creates Block Kit message with Approve/Deny buttons.
// - parseApprovalAction: decodes action_id back to requestId + decision.
// - Draft-edit: send initial "thinking..." message, then update it with final reply.

import { logger } from '../../observability/logger.ts';

/** Slack Block Kit text element. */
export interface SlackTextElement {
  type: 'mrkdwn' | 'plain_text';
  text: string;
  emoji?: boolean;
}

/** Slack Block Kit button element. */
export interface SlackButtonElement {
  type: 'button';
  text: SlackTextElement;
  action_id: string;
  value: string;
  style?: 'primary' | 'danger';
}

/** Slack Block Kit section block. */
export interface SlackSectionBlock {
  type: 'section';
  text: SlackTextElement;
}

/** Slack Block Kit actions block. */
export interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}

/** Slack Block Kit divider block. */
export interface SlackDividerBlock {
  type: 'divider';
}

export type SlackBlock = SlackSectionBlock | SlackActionsBlock | SlackDividerBlock;

/** Prefix for approval action IDs (allows filtering in action handler). */
const APPROVAL_ACTION_PREFIX = 'nimbus_approve:';
const DENIAL_ACTION_PREFIX = 'nimbus_deny:';

/**
 * Build a Slack Block Kit message for a permission-gate approval request.
 * The action_id encodes the requestId for routing back to the permission gate.
 *
 * @param requestId  Permission request ID (from SPEC-401 gate).
 * @param description  Human-readable description of what is being approved.
 */
export function buildApprovalBlocks(requestId: string, description: string): SlackBlock[] {
  // Guard: action_id max length is 255 chars in Slack.
  const safeId = requestId.slice(0, 200);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*nimbus permission request*\n${description}`,
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve', emoji: true },
          action_id: `${APPROVAL_ACTION_PREFIX}${safeId}`,
          value: 'approve',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Deny', emoji: true },
          action_id: `${DENIAL_ACTION_PREFIX}${safeId}`,
          value: 'deny',
          style: 'danger',
        },
      ],
    },
  ];
}

/**
 * Parse a Slack action_id from a Block Kit button callback.
 * Returns `{requestId, approved}` or `null` if malformed / not an approval action.
 */
export function parseApprovalAction(
  actionId: string,
): { requestId: string; approved: boolean } | null {
  try {
    if (actionId.startsWith(APPROVAL_ACTION_PREFIX)) {
      const requestId = actionId.slice(APPROVAL_ACTION_PREFIX.length);
      if (!requestId) return null;
      return { requestId, approved: true };
    }
    if (actionId.startsWith(DENIAL_ACTION_PREFIX)) {
      const requestId = actionId.slice(DENIAL_ACTION_PREFIX.length);
      if (!requestId) return null;
      return { requestId, approved: false };
    }
    return null;
  } catch {
    logger.warn({ actionId }, 'slack: malformed action_id in approval callback');
    return null;
  }
}

/**
 * Build a "draft" (thinking...) message payload for the draft-edit pattern.
 * The caller posts this first, then edits it with the final response.
 */
export function buildDraftBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':hourglass_flowing_sand: _thinking..._',
      },
    },
  ];
}

/**
 * Build the final reply blocks from the agent's text response.
 * Used to update the draft message via `chat.update`.
 */
export function buildReplyBlocks(text: string): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}
