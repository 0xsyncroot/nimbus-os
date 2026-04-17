// approval.ts — SPEC-803 T2 / SPEC-831: Telegram inline keyboard builder + callback parser.
// Inline keyboard gives native mobile-friendly Approve/Always/Deny UX.
// Callback data encodes {requestId, decision} within Telegram's 64-byte limit.

/** Telegram InlineKeyboardButton shape (subset). */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Telegram InlineKeyboardMarkup shape. */
export interface ApprovalKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Options for buildApprovalKeyboard. */
export interface BuildApprovalKeyboardOptions {
  /** When true, adds a third "Always" button between Approve and Deny. Default: false. */
  includeAlways?: boolean;
}

/** Prefix for approval callback data — allows filtering in update handler. */
const APPROVAL_PREFIX = 'apr:';

/** Maximum bytes Telegram allows for callback_data. */
const TELEGRAM_CALLBACK_MAX_BYTES = 64;

/**
 * Build an inline keyboard for a permission-gate approval request.
 * Callback data: `apr:<allow|always|deny>:<requestId>` (truncated to 64 bytes total).
 *
 * When `opts.includeAlways` is true, a third "Always" button is added.
 * The function remains backward-compatible: calling with no opts returns 2 buttons.
 */
export function buildApprovalKeyboard(
  requestId: string,
  opts?: BuildApprovalKeyboardOptions,
): ApprovalKeyboard {
  // Guard: if requestId is too long, truncate to fit within Telegram's limit.
  // Longest prefix is "apr:always:" = 11 chars; leave room for decision prefix.
  const maxIdLen = TELEGRAM_CALLBACK_MAX_BYTES - 'apr:always:'.length;
  const safeId = requestId.slice(0, maxIdLen);

  const approveData = `${APPROVAL_PREFIX}allow:${safeId}`;
  const denyData = `${APPROVAL_PREFIX}deny:${safeId}`;

  const row: InlineKeyboardButton[] = [
    { text: '✅ Approve', callback_data: approveData },
  ];

  if (opts?.includeAlways) {
    const alwaysData = `${APPROVAL_PREFIX}always:${safeId}`;
    row.push({ text: '🔓 Always', callback_data: alwaysData });
  }

  row.push({ text: '❌ Deny', callback_data: denyData });

  return { inline_keyboard: [row] };
}

/** Decision values returned by parseApprovalCallback. */
export type ApprovalDecision = 'allow' | 'always' | 'deny';

/**
 * Parse callback data from a Telegram inline keyboard action.
 * Returns `{requestId, decision}` or `null` if payload is malformed / not an approval.
 */
export function parseApprovalCallback(
  data: string,
): { requestId: string; decision: ApprovalDecision } | null {
  try {
    if (!data.startsWith(APPROVAL_PREFIX)) return null;
    const rest = data.slice(APPROVAL_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) return null;
    const decisionStr = rest.slice(0, colonIdx);
    const requestId = rest.slice(colonIdx + 1);
    if (decisionStr !== 'allow' && decisionStr !== 'always' && decisionStr !== 'deny') return null;
    if (!requestId) return null;
    return { requestId, decision: decisionStr as ApprovalDecision };
  } catch {
    return null;
  }
}

/** Returns byte length of a string (UTF-8). Used for validation assertions. */
export function callbackByteLength(data: string): number {
  return new TextEncoder().encode(data).length;
}
