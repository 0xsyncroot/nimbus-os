// approval.ts — SPEC-803 T2: Telegram inline keyboard builder + callback parser.
// Inline keyboard gives native mobile-friendly Approve/Deny UX.
// Callback data encodes {requestId, approved} within Telegram's 64-byte limit.

/** Telegram InlineKeyboardButton shape (subset). */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Telegram InlineKeyboardMarkup shape. */
export interface ApprovalKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Prefix for approval callback data — allows filtering in update handler. */
const APPROVAL_PREFIX = 'apr:';

/** Maximum bytes Telegram allows for callback_data. */
const TELEGRAM_CALLBACK_MAX_BYTES = 64;

/**
 * Build an inline keyboard for a permission-gate approval request.
 * Callback data: `apr:<1|0>:<requestId>` (truncated to 64 bytes total).
 */
export function buildApprovalKeyboard(requestId: string): ApprovalKeyboard {
  const approveData = `${APPROVAL_PREFIX}1:${requestId}`;
  const denyData = `${APPROVAL_PREFIX}0:${requestId}`;

  // Guard: if requestId is too long, truncate to fit within Telegram's limit.
  const maxIdLen = TELEGRAM_CALLBACK_MAX_BYTES - APPROVAL_PREFIX.length - 2; // "1:" prefix
  const safeId = requestId.slice(0, maxIdLen);

  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `${APPROVAL_PREFIX}1:${safeId}` },
        { text: '❌ Deny', callback_data: `${APPROVAL_PREFIX}0:${safeId}` },
      ],
    ],
  };

  // Prevent unused variable warnings for the original strings.
  void approveData;
  void denyData;
}

/**
 * Parse callback data from a Telegram inline keyboard action.
 * Returns `{requestId, approved}` or `null` if payload is malformed / not an approval.
 */
export function parseApprovalCallback(
  data: string,
): { requestId: string; approved: boolean } | null {
  try {
    if (!data.startsWith(APPROVAL_PREFIX)) return null;
    const rest = data.slice(APPROVAL_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const decisionStr = rest.slice(0, colonIdx);
    const requestId = rest.slice(colonIdx + 1);
    if (decisionStr !== '0' && decisionStr !== '1') return null;
    if (!requestId) return null;
    return { requestId, approved: decisionStr === '1' };
  } catch {
    return null;
  }
}

/** Returns byte length of a string (UTF-8). Used for validation assertions. */
export function callbackByteLength(data: string): number {
  return new TextEncoder().encode(data).length;
}
